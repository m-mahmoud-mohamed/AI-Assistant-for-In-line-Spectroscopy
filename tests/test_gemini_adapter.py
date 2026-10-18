"""Gemini adapter and profile, tested against a mocked google-genai client (no network, no key)."""
import asyncio
import base64
import importlib.util
import json
from pathlib import Path
from typing import Literal

import httpx
import pytest
from google import genai
from google.genai import errors, types
from pydantic import BaseModel, Field

from prism.llm.adapters.base import LLMRequest, ProviderError, RateLimited, ToolCall
from prism.llm.adapters.gemini import SYNTHETIC_ID_PREFIX, GeminiAdapter, convert_messages, to_gemini_schema
from prism.llm.cache import LLMCache, ReplayMiss
from prism.llm.gateway import LLMGateway, LLMUnavailable, ToolSpec, build_gateway
from prism.llm.profiles import Profile, RoleConfig, load_profile

ROOT = Path(__file__).resolve().parents[1]


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---- a fake SDK client built from the SDK's real response types ---------------------------------------------------


class FakeModels:
    def __init__(self, script):
        self.script, self.calls = list(script), []

    def generate_content(self, *, model, contents, config=None):
        self.calls.append({"model": model, "contents": contents, "config": config})
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def embed_content(self, *, model, contents, config=None):
        self.calls.append({"model": model, "contents": contents, "config": config})
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class FakeClient:
    def __init__(self, script=()):
        self.models = FakeModels(script)


def reply(text=None, calls=(), finish="STOP", usage=None, thought=None):
    """calls: (name, args, signature bytes | None, id | None)"""
    parts = [types.Part(text=thought, thought=True)] if thought else []
    if text is not None:
        parts.append(types.Part(text=text))
    for name, args, sig, call_id in calls:
        parts.append(types.Part(function_call=types.FunctionCall(id=call_id, name=name, args=args),
                                thought_signature=sig))
    usage = usage or types.GenerateContentResponseUsageMetadata(prompt_token_count=100, candidates_token_count=20,
                                                                total_token_count=120)
    return types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(role="model", parts=parts),
                                    finish_reason=types.FinishReason(finish))], usage_metadata=usage)


def api_error(code, status, message="boom", details=()):
    cls = errors.ClientError if code < 500 else errors.ServerError
    return cls(code, {"error": {"code": code, "message": message, "status": status, "details": list(details)}}, None)


CAPS = {
    "g-flash": {"json_schema": True, "tools": True, "thinking_levels": ["low", "medium", "high"],
                "thinking_headroom": {"low": 100, "medium": 300, "high": 800, "default": 200}},
    "g-pro": {"thinking_levels": ["low", "high"]},
    "g-nothink": {"thinking_levels": []},
    "g-nojson": {"json_schema": False},
    "g-embed": {"dimensions": 2},
}


def adapter(script=(), caps=None, **kw):
    return GeminiAdapter("key", caps if caps is not None else CAPS, client=FakeClient(script), **kw)


def req(messages=None, model="g-flash", **kw):
    return LLMRequest(model=model, messages=messages or [{"role": "user", "content": "hi"}], **kw)


TOOL = [{"type": "function", "function": {
    "name": "convert_units", "description": "Convert a spectral value",
    "parameters": {"type": "object", "properties": {"value": {"type": "number"}}, "required": ["value"]}}}]


# ---- messages → contents ---------------------------------------------------------------------------------------------


def test_system_messages_become_system_instruction_and_turns_alternate():
    a = adapter([reply("ok")])
    a.complete(req([{"role": "system", "content": "Be brief."}, {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": "hello"}, {"role": "user", "content": "q1"},
                    {"role": "user", "content": "q2"}, {"role": "system", "content": "Cite cards."}],
                   max_tokens=500, temperature=0.2))
    call = a.client.models.calls[0]
    assert call["model"] == "g-flash" and call["config"].system_instruction == "Be brief.\n\nCite cards."
    assert [c.role for c in call["contents"]] == ["user", "model", "user"]
    assert [p.text for p in call["contents"][2].parts] == ["q1", "q2"]            # consecutive turns merged
    assert call["config"].temperature == 0.2
    assert not call["config"].response_mime_type and call["config"].tools is None


def test_temperature_is_left_to_the_provider_when_none_and_text_excludes_thoughts():
    a = adapter([reply("answer", thought="private reasoning")])
    out = a.complete(req(temperature=None))
    assert a.client.models.calls[0]["config"].temperature is None
    assert out.text == "answer" and out.finish_reason == "stop" and out.model == "g-flash"


def test_images_as_data_uris_become_inline_data():
    png = base64.b64encode(b"\x89PNGdata").decode()
    _, contents = convert_messages([{"role": "user", "content": [
        {"type": "text", "text": "Transcribe."}, {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{png}"}}]}])
    parts = contents[0].parts
    assert parts[0].text == "Transcribe." and parts[1].inline_data.data == b"\x89PNGdata"
    assert parts[1].inline_data.mime_type == "image/png"


# ---- structured output -----------------------------------------------------------------------------------------------


class Item(BaseModel):
    kind: Literal["a", "b"] = "a"
    note: str | None = Field(default=None, description="free text")


class Report(BaseModel):
    title: str
    items: list[Item] = []
    count: int = Field(default=0, ge=0, le=9)


def test_pydantic_schema_goes_to_response_json_schema_in_gemini_subset():
    a = adapter([reply('{"title": "t", "items": [], "count": 1}')])
    out = a.complete(req(json_schema=Report.model_json_schema(), schema_name="Report"))
    cfg = a.client.models.calls[0]["config"]
    assert cfg.response_mime_type == "application/json" and out.text.startswith('{"title"')
    schema = cfg.response_json_schema
    assert "default" not in json.dumps(schema) and "$defs" in schema                # unsupported keywords dropped
    assert schema["propertyOrdering"] == ["title", "items", "count"]               # field order kept
    assert schema["properties"]["count"] == {"maximum": 9, "minimum": 0, "type": "integer"}
    json.dumps(schema)


def test_schema_conversion_rules():
    assert to_gemini_schema({"type": "object", "properties": {"x": {"$ref": "#/$defs/A", "description": "d"}},
                             "$defs": {"A": {"type": "string", "pattern": "^a", "default": "a"}}}) == {
        "type": "object", "properties": {"x": {"$ref": "#/$defs/A"}}, "propertyOrdering": ["x"],
        "$defs": {"A": {"type": "string"}}}
    assert to_gemini_schema({"allOf": [{"type": "string"}], "description": "d"}) == {"type": "string", "description": "d"}
    assert to_gemini_schema({"const": "x"}) == {"enum": ["x"], "type": "string"}
    assert to_gemini_schema({"type": ["string", "null"]}) == {"anyOf": [{"type": "string"}, {"type": "null"}]}
    assert to_gemini_schema({"type": "string", "format": "uri"}) == {"type": "string"}
    assert to_gemini_schema({"type": "string", "format": "date-time"}) == {"type": "string", "format": "date-time"}
    assert to_gemini_schema({"allOf": [{"type": "string"}, {"minLength": 1}]}) is None
    assert to_gemini_schema({"type": "object", "properties": {"a": {"not": {"type": "null"}}}}) is None


def test_unsupported_schema_falls_back_to_prompted_json():
    a = adapter([reply('{"a": 1}')])
    schema = {"type": "object", "properties": {"a": {"not": {"type": "null"}}}}
    a.complete(req([{"role": "system", "content": "S"}, {"role": "user", "content": "hi"}], json_schema=schema))
    cfg = a.client.models.calls[0]["config"]
    assert cfg.response_json_schema is None and cfg.response_mime_type == "application/json"
    assert cfg.system_instruction.startswith("S\n\n") and '"not"' in cfg.system_instruction


def test_model_without_json_schema_support_uses_prompted_json():
    a = adapter([reply('{"title": "t"}')])
    a.complete(req(model="g-nojson", json_schema=Report.model_json_schema()))
    cfg = a.client.models.calls[0]["config"]
    assert cfg.response_json_schema is None and "JSON Schema" in cfg.system_instruction


def test_schema_rejected_by_the_api_is_retried_as_prompted_json_and_remembered():
    too_complex = api_error(400, "INVALID_ARGUMENT", "The specified schema produces a constraint that has too many states")
    a = adapter([too_complex, reply('{"title": "t"}'), reply('{"title": "u"}')])
    schema = Report.model_json_schema()
    assert a.complete(req(json_schema=schema)).text == '{"title": "t"}'
    assert a.complete(req([{"role": "user", "content": "again"}], json_schema=schema)).text == '{"title": "u"}'
    configs = [c["config"] for c in a.client.models.calls]
    assert configs[0].response_json_schema is not None
    assert configs[1].response_json_schema is None and configs[2].response_json_schema is None     # remembered
    assert len(configs) == 3


def test_other_400_errors_are_not_retried():
    a = adapter([api_error(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.")])
    with pytest.raises(ProviderError, match="API key not valid"):
        a.complete(req(json_schema=Report.model_json_schema()))
    assert len(a.client.models.calls) == 1


# ---- function calling ------------------------------------------------------------------------------------------------


def test_tools_become_function_declarations():
    a = adapter([reply("ok")])
    a.complete(req(tools=TOOL + [{"type": "function", "function": {"name": "ping", "description": "p",
                                                                   "parameters": {"type": "object"}}}]))
    decls = a.client.models.calls[0]["config"].tools[0].function_declarations
    assert [d.name for d in decls] == ["convert_units", "ping"]
    assert decls[0].parameters_json_schema["properties"]["value"] == {"type": "number"}
    assert decls[1].parameters_json_schema is None and decls[0].description == "Convert a spectral value"
    assert a.client.models.calls[0]["config"].automatic_function_calling.disable is True


def test_function_call_round_trip_keeps_the_thought_signature():
    sig = b"\x01\x02opaque-signature\xff"
    a = adapter([reply(None, calls=[("convert_units", {"value": 4000}, sig, None)], finish="STOP"),
                 reply("4000 cm-1 is 2.5 um.")])
    first = a.complete(req([{"role": "user", "content": "convert"}], tools=TOOL))
    call = first.tool_calls[0]
    assert first.finish_reason == "tool_calls" and call.name == "convert_units" and json.loads(call.arguments) == {"value": 4000}
    assert call.id.startswith(SYNTHETIC_ID_PREFIX)
    assert base64.b64decode(call.extra_content["google"]["thought_signature"]) == sig

    followup = [{"role": "user", "content": "convert"}, {"role": "assistant", "content": "", "tool_calls": [call.to_message()]},
                {"role": "tool", "tool_call_id": call.id, "content": json.dumps({"value": 2.5})}]
    second = a.complete(req(followup, tools=TOOL))
    assert second.text == "4000 cm-1 is 2.5 um."
    contents = a.client.models.calls[1]["contents"]
    assert [c.role for c in contents] == ["user", "model", "user"]
    sent = contents[1].parts[0]
    assert sent.function_call.name == "convert_units" and sent.function_call.args == {"value": 4000}
    assert sent.thought_signature == sig                                 # the signature went back untouched
    assert sent.function_call.id is None                                 # invented ids are not sent to the API
    result = contents[2].parts[0].function_response
    assert result.name == "convert_units" and result.response == {"value": 2.5} and result.id is None


def test_parallel_calls_keep_their_own_signatures_and_results_share_one_turn():
    a = adapter([reply(None, calls=[("convert_units", {"value": 1}, b"sig1", "id-1"),
                                    ("ping", {}, None, "id-2")]), reply("done")])
    first = a.complete(req(tools=TOOL))
    c1, c2 = first.tool_calls
    assert (c1.id, c2.id) == ("id-1", "id-2") and c2.extra_content is None
    a.complete(req([{"role": "user", "content": "go"},
                    {"role": "assistant", "content": "", "tool_calls": [c1.to_message(), c2.to_message()]},
                    {"role": "tool", "tool_call_id": "id-1", "content": '{"v": 1}'},
                    {"role": "tool", "tool_call_id": "id-2", "content": "pong"},
                    {"role": "user", "content": "Tool limit reached. Answer now."}], tools=TOOL))
    contents = a.client.models.calls[1]["contents"]
    model_parts, user_parts = contents[1].parts, contents[2].parts
    assert [p.function_call.id for p in model_parts] == ["id-1", "id-2"]            # real ids are sent back
    assert [p.thought_signature for p in model_parts] == [b"sig1", None]
    assert [p.function_response.name for p in user_parts[:2]] == ["convert_units", "ping"]
    assert user_parts[1].function_response.response == {"output": "pong"}           # non-JSON result is wrapped
    assert user_parts[2].text == "Tool limit reached. Answer now." and len(contents) == 3


def test_gateway_run_tools_loop_with_gemini(tmp_path):
    sig = b"sig-bytes"
    client = FakeClient([reply(None, calls=[("convert_units", {"value": 4000}, sig, None)]), reply("2.5 um.")])
    profile = Profile("g", "gemini", "", "GEMINI_API_KEY", roles={"agent": RoleConfig(models=["g-flash"], reasoning="low")})
    gw = LLMGateway(profile, GeminiAdapter("k", CAPS, client=client), LLMCache(tmp_path))
    tool = ToolSpec("convert_units", "convert", TOOL[0]["function"]["parameters"], lambda args: {"value": 10000 / args["value"]})
    out = gw.run_tools("agent", [{"role": "user", "content": "convert 4000"}], [tool])
    assert out.text == "2.5 um." and out.calls[0]["result"] == {"value": 2.5}
    assert client.models.calls[1]["contents"][1].parts[0].thought_signature == sig


# ---- thinking, tokens, usage -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("reasoning,level", [("off", "LOW"), ("low", "LOW"), ("medium", "MEDIUM"), ("high", "HIGH")])
def test_reasoning_maps_to_thinking_level(reasoning, level):
    a = adapter([reply("ok")])
    a.complete(req(reasoning=reasoning, max_tokens=1000))
    tc = a.client.models.calls[0]["config"].thinking_config
    assert tc.thinking_level == types.ThinkingLevel(level) and tc.include_thoughts is False and tc.thinking_budget is None


def test_thinking_is_not_sent_when_the_model_decides_or_cannot_think():
    a = adapter([reply("ok"), reply("ok"), reply("ok")])
    a.complete(req(reasoning="model_default"))
    a.complete(req(model="g-nothink", reasoning="high"))
    a.complete(req(reasoning="unknown-value"))
    assert [c["config"].thinking_config for c in a.client.models.calls] == [None, None, None]


def test_unlisted_level_is_mapped_to_the_nearest_listed_one():
    a = adapter([reply("ok"), reply("ok"), reply("ok")])
    a.complete(req(model="g-pro", reasoning="medium"))        # low/high only; a tie goes to the higher level
    a.complete(req(model="g-pro", reasoning="off"))
    a.complete(req(model="unlisted-model", reasoning="high"))   # not in the capabilities: levels low/medium/high assumed
    assert [c["config"].thinking_config.thinking_level.value for c in a.client.models.calls] == ["HIGH", "LOW", "HIGH"]


def test_thinking_budget_models_get_a_budget_instead_of_a_level():
    caps = {"old": {"thinking_levels": ["low", "high"], "thinking_budgets": {"low": 512, "high": 8192}}}
    a = adapter([reply("ok")], caps=caps)
    a.complete(req(model="old", reasoning="high"))
    tc = a.client.models.calls[0]["config"].thinking_config
    assert tc.thinking_budget == 8192 and tc.thinking_level is None


def test_thinking_headroom_is_added_to_max_output_tokens():
    a = adapter([reply("ok"), reply("ok"), reply("ok"), reply("ok")])
    a.complete(req(reasoning="low", max_tokens=1500))
    a.complete(req(reasoning="high", max_tokens=1500))
    a.complete(req(reasoning="model_default", max_tokens=1500))      # headroom "default"
    a.complete(req(model="g-pro", reasoning="low", max_tokens=1500))  # no headroom configured
    assert [c["config"].max_output_tokens for c in a.client.models.calls] == [1600, 2300, 1700, 1500]


def test_usage_includes_prompt_output_thinking_and_cached_tokens():
    meta = types.GenerateContentResponseUsageMetadata(prompt_token_count=1000, cached_content_token_count=800,
                                                      candidates_token_count=40, thoughts_token_count=120,
                                                      total_token_count=1160)
    out = adapter([reply("ok", usage=meta)]).complete(req())
    assert out.usage == {"prompt_tokens": 1000, "completion_tokens": 40, "thinking_tokens": 120, "cached_tokens": 800,
                         "tool_use_prompt_tokens": 0, "total_tokens": 1160}
    bare = types.GenerateContentResponse(candidates=reply("x").candidates)
    assert adapter([bare]).complete(req()).usage == {}


def test_finish_reasons():
    assert adapter([reply("{", finish="MAX_TOKENS")]).complete(req()).finish_reason == "length"
    for bad in ("SAFETY", "RECITATION", "MALFORMED_FUNCTION_CALL", "OTHER"):
        with pytest.raises(ProviderError, match=bad):
            adapter([reply("x", finish=bad)]).complete(req())
    blocked = types.GenerateContentResponse(
        candidates=[], prompt_feedback=types.GenerateContentResponsePromptFeedback(block_reason=types.BlockedReason.SAFETY))
    with pytest.raises(ProviderError, match="prompt blocked"):
        adapter([blocked]).complete(req())


# ---- errors → gateway retry and fallback -------------------------------------------------------------------------------


RETRY = {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "27s"}
DAILY = {"@type": "type.googleapis.com/google.rpc.QuotaFailure",
         "violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}


def test_429_and_503_are_retryable_and_carry_the_retry_delay():
    with pytest.raises(RateLimited) as e:
        adapter([api_error(429, "RESOURCE_EXHAUSTED", "quota", [RETRY])]).complete(req())
    assert e.value.reset_seconds == 27.0
    with pytest.raises(RateLimited) as e:
        adapter([api_error(429, "RESOURCE_EXHAUSTED", "Please retry in 4.5s.")]).complete(req())
    assert e.value.reset_seconds == 4.5
    with pytest.raises(RateLimited) as e:
        adapter([api_error(503, "UNAVAILABLE", "The model is overloaded.")]).complete(req())
    assert e.value.reset_seconds == 3.0
    with pytest.raises(RateLimited) as e:
        adapter([api_error(429, "RESOURCE_EXHAUSTED", "quota")]).complete(req())
    assert e.value.reset_seconds == 10.0


@pytest.mark.parametrize("err", [api_error(400, "INVALID_ARGUMENT", "bad"), api_error(404, "NOT_FOUND", "no such model"),
                                 api_error(403, "PERMISSION_DENIED", "denied"), api_error(500, "INTERNAL", "oops"),
                                 api_error(429, "RESOURCE_EXHAUSTED", "daily", [DAILY, RETRY]),
                                 httpx.ReadTimeout("slow"), httpx.ConnectError("down")])
def test_other_failures_are_not_retried_on_the_same_model(err):
    with pytest.raises(ProviderError):
        adapter([err]).complete(req())


def gateway(tmp_path, script, models=("g-flash", "g-pro")):
    client = FakeClient(script)
    profile = Profile("g", "gemini", "", "GEMINI_API_KEY", roles={"writer": RoleConfig(models=list(models))})
    slept = []
    return LLMGateway(profile, GeminiAdapter("k", CAPS, client=client), LLMCache(tmp_path), sleep=slept.append), client, slept


class Out(BaseModel):
    answer: str


def test_gateway_waits_and_retries_on_429(tmp_path):
    gw, client, slept = gateway(tmp_path, [api_error(429, "RESOURCE_EXHAUSTED", "q", [RETRY]), reply('{"answer": "ok"}')])
    out = gw.complete("writer", [{"role": "user", "content": "q"}], schema=Out)
    assert out.parsed.answer == "ok" and slept == [27.0] and [c["model"] for c in client.models.calls] == ["g-flash"] * 2


def test_gateway_falls_back_to_the_next_model_after_repeated_429(tmp_path):
    limited = api_error(429, "RESOURCE_EXHAUSTED", "q", [{"@type": "x.RetryInfo", "retryDelay": "2s"}])
    gw, client, _ = gateway(tmp_path, [limited, limited, limited, reply('{"answer": "pro"}')])
    out = gw.complete("writer", [{"role": "user", "content": "q"}], schema=Out)
    assert out.parsed.answer == "pro" and out.model == "g-pro"
    assert [c["model"] for c in client.models.calls] == ["g-flash"] * 3 + ["g-pro"]


def test_gateway_falls_back_immediately_on_503_after_retries_and_on_400_and_all_failing_raises(tmp_path):
    gw, client, _ = gateway(tmp_path, [api_error(400, "INVALID_ARGUMENT", "bad"), reply('{"answer": "b"}')])
    assert gw.complete("writer", [{"role": "user", "content": "q"}], schema=Out).model == "g-pro"
    assert [c["model"] for c in client.models.calls] == ["g-flash", "g-pro"]       # no retry on a 400
    gw2, _, _ = gateway(tmp_path / "2", [api_error(404, "NOT_FOUND", "x"), api_error(404, "NOT_FOUND", "y")])
    with pytest.raises(LLMUnavailable):
        gw2.complete("writer", [{"role": "user", "content": "q"}], schema=Out)


def test_truncated_json_falls_back_to_the_next_model(tmp_path):
    gw, _, _ = gateway(tmp_path, [reply('{"answ', finish="MAX_TOKENS"), reply('{"answer": "ok"}')])
    out = gw.complete("writer", [{"role": "user", "content": "q"}], schema=Out)
    assert out.model == "g-pro" and out.parsed.answer == "ok"


# ---- embeddings ----------------------------------------------------------------------------------------------------------


def embedding_reply(vectors):
    return types.EmbedContentResponse(embeddings=[types.ContentEmbedding(values=v) for v in vectors])


def test_embeddings_are_batched_in_order():
    texts = [f"t{i}" for i in range(250)]
    script = [embedding_reply([[float(i)] * 3 for i in range(start, min(start + 100, 250))]) for start in (0, 100, 200)]
    a = adapter(script)
    vectors = a.embed("gemini-embedding-001", texts)
    sent = [[c.parts[0].text for c in call["contents"]] for call in a.client.models.calls]
    assert [len(s) for s in sent] == [100, 100, 50] and [t for batch in sent for t in batch] == texts
    assert [v[0] for v in vectors] == [float(i) for i in range(250)] and len(vectors[0]) == 3
    assert a.client.models.calls[0]["config"] is None


def test_reduced_embeddings_are_normalised_and_dimensions_are_requested():
    a = adapter([embedding_reply([[3.0, 4.0]])])
    assert a.embed("g-embed", ["x"]) == [[0.6, 0.8]]
    assert a.client.models.calls[0]["config"].output_dimensionality == 2


def test_embedding_errors():
    with pytest.raises(ProviderError, match="mismatch"):
        adapter([embedding_reply([[1.0]])]).embed("gemini-embedding-001", ["a", "b"])
    with pytest.raises(RateLimited):
        adapter([api_error(429, "RESOURCE_EXHAUSTED", "q", [RETRY])]).embed("gemini-embedding-001", ["a"])
    assert adapter().embed("gemini-embedding-001", []) == []


def test_gateway_embed_uses_cache_and_the_embedder_role(tmp_path):
    client = FakeClient([embedding_reply([[1.0, 2.0], [3.0, 4.0]])])
    profile = Profile("g", "gemini", "", "K", roles={"embedder": RoleConfig(models=["gemini-embedding-001"])})
    gw = LLMGateway(profile, GeminiAdapter("k", CAPS, client=client), LLMCache(tmp_path))
    assert gw.embed(["a", "b"]) == [[1.0, 2.0], [3.0, 4.0]] and gw.embed(["a", "b"]) == [[1.0, 2.0], [3.0, 4.0]]
    assert len(client.models.calls) == 1


# ---- key handling, replay, client construction ------------------------------------------------------------------------------


def test_missing_key_is_a_clear_provider_error_and_builds_no_client(monkeypatch):
    monkeypatch.setattr(genai, "Client", lambda **kw: pytest.fail("client must not be built without a key"))
    with pytest.raises(ProviderError, match="GEMINI_API_KEY is not set"):
        GeminiAdapter("").complete(req())


def test_client_is_built_lazily_once_with_key_and_timeout(monkeypatch):
    built = []

    class StubClient:
        def __init__(self, **kw):
            built.append(kw)
            self.models = FakeModels([reply("a"), reply("b")])

    monkeypatch.setattr(genai, "Client", StubClient)
    a = GeminiAdapter("secret", {}, timeout_s=30)
    assert built == []
    a.complete(req())
    a.complete(req())
    assert len(built) == 1 and built[0]["api_key"] == "secret" and built[0]["http_options"].timeout == 30000


def test_build_gateway_for_gemini_needs_no_key_and_replay_never_reaches_the_sdk(tmp_path, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr(genai, "Client", lambda **kw: pytest.fail("replay must not touch the SDK"))
    gw = build_gateway("gemini", cache_dir=tmp_path, replay=True)
    assert isinstance(gw.adapter, GeminiAdapter) and gw.profile.name == "gemini"
    with pytest.raises(ReplayMiss):
        gw.complete("writer", [{"role": "user", "content": "q"}], schema=Out)
    with pytest.raises(ReplayMiss):
        gw.embed(["a"])


def test_cached_tool_call_replays_with_its_signature(tmp_path):
    client = FakeClient([reply(None, calls=[("convert_units", {"value": 1}, b"sg", None)])])
    profile = Profile("g", "gemini", "", "K", roles={"agent": RoleConfig(models=["g-flash"])})
    live = LLMGateway(profile, GeminiAdapter("k", CAPS, client=client), LLMCache(tmp_path))
    first = live.complete("agent", [{"role": "user", "content": "x"}], tools=TOOL)
    replay = LLMGateway(profile, GeminiAdapter(""), LLMCache(tmp_path, replay=True))
    again = replay.complete("agent", [{"role": "user", "content": "x"}], tools=TOOL)
    assert again.cached and again.tool_calls == first.tool_calls and again.tool_calls[0].extra_content


def test_shipped_gemini_profile_builds_valid_requests():
    """Every model/role of config/llm.yaml produces a request the SDK types accept."""
    profile = load_profile(ROOT / "config" / "llm.yaml", "gemini")
    for role, rc in profile.roles.items():
        if role == "embedder":
            continue
        a = GeminiAdapter("k", profile.capabilities, client=FakeClient([reply('{"answer": "x"}')] * len(rc.models)))
        for model in rc.models:
            a.complete(LLMRequest(model=model, messages=[{"role": "user", "content": "q"}], reasoning=rc.reasoning,
                                  max_tokens=rc.max_tokens, temperature=rc.temperature,
                                  json_schema=Out.model_json_schema()))
        for call in a.client.models.calls:
            cfg = call["config"]
            assert cfg.thinking_config.thinking_level.value == rc.reasoning.upper()
            assert cfg.max_output_tokens > rc.max_tokens and cfg.temperature is None


# ---- probe and bench ---------------------------------------------------------------------------------------------------------


def test_deep_probe_checks_tool_round_trip_and_thinking_levels(tmp_path):
    probe_llm = load_script("probe_llm")
    sig = {"google": {"thought_signature": "c2ln"}}

    class ProbeAdapter:
        def __init__(self):
            self.requests = []

        def complete(self, r):
            self.requests.append(r)
            from prism.llm.adapters.base import LLMResponse
            if r.tools and not any(m["role"] == "tool" for m in r.messages):
                return LLMResponse("", "tool_calls", r.model, tool_calls=[ToolCall("1", "convert_units", "{}", sig)])
            if r.json_schema:
                return LLMResponse('{"ok": true}', "stop", r.model)
            return LLMResponse("2.5 um" if r.tools else "yes", "stop", r.model, usage={"thinking_tokens": 7})

        def embed(self, model, texts):
            return [[0.1] * 4]

    profile = Profile("g", "gemini", "", "K", capabilities={"m1": {"thinking_levels": ["low", "medium", "high"]}},
                      roles={"writer": RoleConfig(models=["m1"]), "embedder": RoleConfig(models=["e1"])})
    adapter_ = ProbeAdapter()
    gw = LLMGateway(profile, adapter_, LLMCache(tmp_path))
    report = probe_llm.probe(gw)                                  # deep by default for the gemini adapter
    m1 = report["models"]["m1"]
    assert m1["json_schema"] and m1["tools"] and m1["tool_roundtrip"] is True
    assert m1["thinking"] == {"low": {"accepted": True, "thinking_tokens": 7, "finish_reason": "stop"},
                              "high": {"accepted": True, "thinking_tokens": 7, "finish_reason": "stop"}}
    roundtrip = next(r for r in adapter_.requests if any(m["role"] == "tool" for m in r.messages))
    assert roundtrip.messages[1]["tool_calls"][0]["extra_content"] == sig
    assert report["embeddings"] == {"e1": 4}
    shallow = probe_llm.probe(gw, deep=False)
    assert "tool_roundtrip" not in shallow["models"]["m1"] and "thinking" not in shallow["models"]["m1"]


def sse(*events):
    return ("".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n").encode()


def test_bench_profile_targets_the_gemini_openai_endpoint_and_sends_reasoning_effort(tmp_path):
    bench = load_script("bench_llm")
    base, key_env, models = bench.resolve_target("gemini", str(ROOT / "config" / "llm.yaml"))
    assert base == "https://generativelanguage.googleapis.com/v1beta/openai" and key_env == "GEMINI_API_KEY"
    assert models == ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
    gwdg_base, gwdg_key, _ = bench.resolve_target("gwdg", str(ROOT / "config" / "llm.yaml"))
    assert gwdg_base == "https://chat-ai.academiccloud.de/v1" and gwdg_key == "SAIA_API_KEY"
    assert bench.resolve_target("project", str(ROOT / "config" / "llm.yaml"))[2] == []     # no roles filled in yet
    other = tmp_path / "llm.yaml"
    other.write_text("active_profile: a\nprofiles:\n  a: {adapter: anthropic, api_key_env: K, roles: {}}\n")
    with pytest.raises(SystemExit):
        bench.resolve_target("a", str(other))                       # no OpenAI-compatible endpoint

    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, content=sse({"choices": [{"delta": {"content": "Hello"}}]},
                                                {"choices": [{"delta": {"content": " world"}}]},
                                                {"choices": [], "usage": {"completion_tokens": 42}}),
                              headers={"content-type": "text/event-stream", "x-ratelimit-remaining-minute": "9"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await bench.one(c, base + "/", "test-key", "gemini-3.8-flash", reasoning="low", max_tokens=1600,
                                   temperature=None)

    result = asyncio.run(run())
    request = seen[0]
    body = json.loads(request.content)
    assert request.url.path == "/v1beta/openai/chat/completions" and request.headers["authorization"] == "Bearer test-key"
    assert body["reasoning_effort"] == "low" and body["max_tokens"] == 1600 and "temperature" not in body
    assert body["stream"] is True and body["model"] == "gemini-3.8-flash"
    assert result["model"] == "gemini-3.8-flash" and result["status"] == 200 and result["out_tokens"] == 42
    assert result["limits"] == {"x-ratelimit-remaining-minute": "9"} and result["ttft_s"] >= 0


# ---- the real SDK over a mocked HTTP transport: what actually goes on the wire --------------------------------------------


def wire_adapter(handler, caps=None):
    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = genai.Client(api_key="test-key", http_options=types.HttpOptions(httpx_client=http))
    return GeminiAdapter("test-key", caps if caps is not None else CAPS, client=client)


def field(d, camel, snake):
    return d[camel] if camel in d else d[snake]


def test_wire_request_and_reply_through_the_real_sdk():
    sig = b"\x01\x02sig\xff\xfe"
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={
            "candidates": [{"content": {"role": "model", "parts": [
                {"functionCall": {"name": "convert_units", "args": {"value": 4000}},
                 "thoughtSignature": base64.b64encode(sig).decode()}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 3, "thoughtsTokenCount": 7,
                              "cachedContentTokenCount": 4, "totalTokenCount": 20}})

    a = wire_adapter(handler)
    first = a.complete(req([{"role": "system", "content": "S"}, {"role": "user", "content": "convert"}],
                           json_schema=Out.model_json_schema(), tools=TOOL, reasoning="low", max_tokens=500,
                           temperature=None))
    request = seen[0]
    body = json.loads(request.content)
    assert request.url.path == "/v1beta/models/g-flash:generateContent"
    assert request.headers["x-goog-api-key"] == "test-key" and "test-key" not in str(request.url)
    assert body["systemInstruction"]["parts"][0]["text"] == "S"
    assert body["contents"] == [{"role": "user", "parts": [{"text": "convert"}]}]
    cfg = body["generationConfig"]
    assert cfg["maxOutputTokens"] == 600 and cfg["responseMimeType"] == "application/json" and "temperature" not in cfg
    assert field(cfg, "responseJsonSchema", "response_json_schema")["required"] == ["answer"]
    thinking = field(cfg, "thinkingConfig", "thinking_config")
    assert field(thinking, "thinkingLevel", "thinking_level") == "LOW"
    assert field(body["tools"][0], "functionDeclarations", "function_declarations")[0]["name"] == "convert_units"
    assert first.usage == {"prompt_tokens": 10, "completion_tokens": 3, "thinking_tokens": 7, "cached_tokens": 4,
                           "tool_use_prompt_tokens": 0, "total_tokens": 20}

    call = first.tool_calls[0]
    a.complete(req([{"role": "user", "content": "convert"}, {"role": "assistant", "content": "", "tool_calls": [call.to_message()]},
                    {"role": "tool", "tool_call_id": call.id, "content": '{"value": 2.5}'}], tools=TOOL))
    sent = json.loads(seen[1].content)["contents"]
    part = sent[1]["parts"][0]
    assert base64.urlsafe_b64decode(part["thoughtSignature"]) == sig             # same bytes back on the wire
    assert part["functionCall"] == {"name": "convert_units", "args": {"value": 4000}}
    assert sent[2]["parts"][0]["functionResponse"] == {"name": "convert_units", "response": {"value": 2.5}}


def test_wire_errors_map_to_retryable_and_fatal():
    def status(code, payload):
        return lambda request: httpx.Response(code, json=payload)

    limited = {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "quota", "details": [RETRY]}}
    with pytest.raises(RateLimited) as e:
        wire_adapter(status(429, limited)).complete(req())
    assert e.value.reset_seconds == 27.0
    with pytest.raises(RateLimited):
        wire_adapter(status(503, {"error": {"code": 503, "status": "UNAVAILABLE", "message": "overloaded"}})).complete(req())
    with pytest.raises(ProviderError, match="404"):
        wire_adapter(status(404, {"error": {"code": 404, "status": "NOT_FOUND", "message": "no model"}})).complete(req())
    with pytest.raises(ProviderError, match="API key not valid"):
        wire_adapter(status(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT",
                                            "message": "API key not valid. Please pass a valid API key."}})).complete(req())


def test_wire_embeddings_use_batch_embed_contents():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"embeddings": [{"values": [0.5, 0.5]} for _ in seen[-1]["requests"]]})

    vectors = wire_adapter(handler).embed("gemini-embedding-001", [f"t{i}" for i in range(130)])
    assert [len(b["requests"]) for b in seen] == [100, 30] and len(vectors) == 130
    assert seen[0]["requests"][0]["content"]["parts"][0]["text"] == "t0"


def test_unreadable_sdk_reply_and_unrelated_schema_errors_become_provider_errors():
    with pytest.raises(ProviderError, match="unreadable"):
        adapter([ValueError("not json")]).complete(req())
    schema_complaint = api_error(400, "INVALID_ARGUMENT", "Invalid function declaration schema")
    a = adapter([schema_complaint])
    with pytest.raises(ProviderError, match="function declaration"):
        a.complete(req(tools=TOOL))                    # no response schema was sent: no prompted-JSON retry
    assert len(a.client.models.calls) == 1


def test_tool_call_arguments_may_already_be_a_dict():
    _, contents = convert_messages([{"role": "assistant", "content": "", "tool_calls": [
        {"id": "x", "type": "function", "function": {"name": "f", "arguments": {"a": 1}}}]}])
    assert contents[0].role == "model" and contents[0].parts[0].function_call.args == {"a": 1}


def test_fallback_keys_take_over_on_a_429_and_a_key_out_of_quota_rests(monkeypatch):
    daily = api_error(429, "RESOURCE_EXHAUSTED", "quota", [DAILY])
    script = {"k1": [daily], "k2": [api_error(429, "RESOURCE_EXHAUSTED", "slow down"), reply("from k2 later")],
              "k3": [reply("from k3")]}
    used = []

    class StubClient:
        def __init__(self, api_key, **kw):
            self.models = FakeModels([])
            self.models.generate_content = lambda **_: (used.append(api_key), _pop(script[api_key]))[1]

    def _pop(queue):
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(genai, "Client", StubClient)
    a = GeminiAdapter(["k1", "k2", "k3"], CAPS)
    assert a.complete(req()).text == "from k3" and used == ["k1", "k2", "k3"]   # quota, rate limit, then k3
    assert a.complete(req()).text == "from k2 later" and used[-1] == "k2"       # k1 rests for this model


def test_with_one_key_a_rate_limit_still_goes_back_to_the_gateway(monkeypatch):
    a = adapter([api_error(429, "RESOURCE_EXHAUSTED", "slow down")])
    with pytest.raises(RateLimited):
        a.complete(req())


def test_the_profile_reads_numbered_fallback_keys(monkeypatch):
    from prism.llm.profiles import Profile
    for name, value in (("GKEY", "a"), ("GKEY_2", "b"), ("GKEY_3", ""), ("GKEY_4", "a")):
        monkeypatch.setenv(name, value)
    assert Profile(name="p", adapter="gemini", base_url="", api_key_env="GKEY", roles={}).api_keys() == ["a", "b"]
