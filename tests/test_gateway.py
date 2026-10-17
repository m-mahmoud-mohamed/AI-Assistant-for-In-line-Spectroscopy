import pytest
from pydantic import BaseModel

from prism.llm.adapters.base import LLMResponse, ProviderError, RateLimited, ToolCall
from prism.llm.cache import LLMCache, ReplayMiss
from prism.llm.gateway import LLMGateway, LLMUnavailable, ToolSpec, extract_json
from prism.llm.profiles import Profile, RoleConfig
from prism.llm.prompts import render


class Out(BaseModel):
    answer: str


class FakeAdapter:
    def __init__(self, script):
        self.script, self.requests = list(script), []

    def complete(self, req):
        self.requests.append(req)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def embed(self, model, texts):
        return [[1.0, 0.0] for _ in texts]


def resp(text, finish="stop", model="m1", calls=()):
    return LLMResponse(text=text, finish_reason=finish, model=model, tool_calls=list(calls))


def make(tmp_path, script, replay=False):
    profile = Profile(name="test", adapter="fake", base_url="", api_key_env="X",
                      roles={"generator": RoleConfig(models=["m1", "m2"]), "embedder": RoleConfig(models=["e1"])})
    slept = []
    gw = LLMGateway(profile, FakeAdapter(script), LLMCache(tmp_path, replay=replay), sleep=slept.append)
    return gw, slept


def test_valid_json_is_parsed(tmp_path):
    gw, _ = make(tmp_path, [resp('```json\n{"answer": "ok"}\n```')])
    assert gw.complete("generator", [{"role": "user", "content": "q"}], schema=Out).parsed.answer == "ok"


def test_invalid_json_is_repaired_once(tmp_path):
    gw, _ = make(tmp_path, [resp("not json"), resp('{"answer": "fixed"}')])
    res = gw.complete("generator", [{"role": "user", "content": "q"}], schema=Out)
    assert res.parsed.answer == "fixed"
    assert "did not validate" in gw.adapter.requests[1].messages[-1]["content"]


def test_truncated_output_falls_back_to_next_model(tmp_path):
    gw, _ = make(tmp_path, [resp('{"answ', finish="length"), resp('{"answer": "ok"}', model="m2")])
    res = gw.complete("generator", [{"role": "user", "content": "q"}], schema=Out)
    assert res.model == "m2" and [r.model for r in gw.adapter.requests] == ["m1", "m2"]


def test_rate_limit_waits_then_succeeds(tmp_path):
    gw, slept = make(tmp_path, [RateLimited(3.0), resp('{"answer": "ok"}')])
    assert gw.complete("generator", [{"role": "user", "content": "q"}], schema=Out).parsed.answer == "ok"
    assert slept == [3.0]


def test_provider_error_falls_back(tmp_path):
    gw, _ = make(tmp_path, [ProviderError("500"), resp('{"answer": "ok"}', model="m2")])
    assert gw.complete("generator", [{"role": "user", "content": "q"}], schema=Out).model == "m2"


def test_all_models_failing_raises(tmp_path):
    gw, _ = make(tmp_path, [ProviderError("a"), ProviderError("b")])
    with pytest.raises(LLMUnavailable):
        gw.complete("generator", [{"role": "user", "content": "q"}], schema=Out)


def test_cache_hit_skips_adapter_and_replay_miss_raises(tmp_path):
    gw, _ = make(tmp_path, [resp('{"answer": "ok"}')])
    msgs = [{"role": "user", "content": "q"}]
    gw.complete("generator", msgs, schema=Out)
    again = gw.complete("generator", msgs, schema=Out)
    assert again.cached and len(gw.adapter.requests) == 1
    replay, _ = make(tmp_path, [], replay=True)
    with pytest.raises(ReplayMiss):
        replay.complete("generator", [{"role": "user", "content": "other"}], schema=Out)


def test_run_tools_executes_tool_and_returns_answer(tmp_path):
    call = ToolCall(id="1", name="convert_units", arguments='{"value": 4000, "from_unit": "cm-1", "to_unit": "um"}')
    gw, _ = make(tmp_path, [resp("", calls=[call]), resp("4000 cm-1 is 2.5 µm.")])
    tool = ToolSpec("convert_units", "convert", {"type": "object"}, lambda a: {"value": 10000 / a["value"]})
    out = gw.run_tools("generator", [{"role": "user", "content": "convert"}], [tool])
    assert out.text.startswith("4000") and out.calls[0]["result"] == {"value": 2.5}


def test_extract_json_strips_fences():
    assert extract_json('Here:\n```json\n{"a": 1}\n```') == '{"a": 1}'


def test_prompt_render_returns_stable_hash():
    text, h1 = render("_shared.j2")
    _, h2 = render("_shared.j2")
    assert "Do not invent" in text and h1 == h2 and len(h1) == 12
