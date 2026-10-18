import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import BaseModel

from prism.llm.adapters.base import LLMResponse, ProviderError, RateLimited, ToolCall
from prism.llm.budget import BudgetMeter
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


# ---- role aliases ------------------------------------------------------------------------------------------------


def test_new_and_legacy_role_names_reach_the_same_models(tmp_path):
    gw, _ = make(tmp_path, [resp('{"answer": "a"}'), resp('{"answer": "b"}')])
    gw.complete("writer", [{"role": "user", "content": "q1"}], schema=Out)
    gw.complete("generator", [{"role": "user", "content": "q2"}], schema=Out)
    assert [r.model for r in gw.adapter.requests] == ["m1", "m1"]
    legacy = Profile(name="old", adapter="fake", base_url="", api_key_env="X",
                     roles={"critic": RoleConfig(models=["c1"], max_tokens=777)})
    old = LLMGateway(legacy, FakeAdapter([resp('{"answer": "a"}')]), LLMCache(tmp_path / "old"))
    old.complete("judge", [{"role": "user", "content": "q"}], schema=Out)
    assert old.adapter.requests[0].model == "c1" and old.adapter.requests[0].max_tokens == 777


# ---- thread safety -----------------------------------------------------------------------------------------------


class SlowAdapter:
    """Answers each request with its own prompt; counts calls per prompt and the peak number running at once."""

    def __init__(self, delay=0.03):
        self.delay, self.lock, self.calls, self.running, self.peak = delay, threading.Lock(), {}, 0, 0

    def complete(self, req):
        prompt = req.messages[-1]["content"]
        with self.lock:
            self.calls[prompt] = self.calls.get(prompt, 0) + 1
            self.running += 1
            self.peak = max(self.peak, self.running)
        time.sleep(self.delay)
        with self.lock:
            self.running -= 1
        return LLMResponse(text=json.dumps({"answer": prompt}), finish_reason="stop", model=req.model,
                           usage={"prompt_tokens": 10, "completion_tokens": 2, "cached_tokens": 4})

    def embed(self, model, texts):
        return [[float(len(t))] for t in texts]


def parallel_gateway(tmp_path, adapter, limits=None):
    profile = Profile(name="par", adapter="fake", base_url="", api_key_env="X", limits=limits or {},
                      roles={"writer": RoleConfig(models=["m1"]), "embedder": RoleConfig(models=["e1"])})
    return LLMGateway(profile, adapter, LLMCache(tmp_path), sleep=lambda s: None)


def test_parallel_complete_calls_write_consistent_cache_entries(tmp_path):
    gw = parallel_gateway(tmp_path, SlowAdapter())
    prompts = [f"section {i}" for i in range(12)]
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda q: gw.complete("writer", [{"role": "user", "content": q}], schema=Out), prompts))
    assert [r.parsed.answer for r in results] == prompts           # every thread got its own answer back
    assert gw.adapter.peak > 1                                      # the calls really overlapped
    entries = list(tmp_path.rglob("*.json"))
    assert len(entries) == len(prompts) and not list(tmp_path.rglob("*.tmp"))
    for f in entries:                                               # each entry is complete, valid JSON
        assert LLMResponse.from_dict(json.loads(f.read_text(encoding="utf-8"))).text.startswith("{")
    assert len(gw.calls) == len(prompts) and gw.budget.snapshot()["total_calls"] == len(prompts)
    replay = LLMGateway(gw.profile, None, LLMCache(tmp_path, replay=True))
    assert [replay.complete("writer", [{"role": "user", "content": q}], schema=Out).parsed.answer
            for q in prompts] == prompts                           # a second run is served from the files alone


def test_identical_parallel_requests_are_sent_once(tmp_path):
    gw = parallel_gateway(tmp_path, SlowAdapter(delay=0.1))
    with ThreadPoolExecutor(max_workers=6) as pool:
        out = list(pool.map(lambda _: gw.complete("writer", [{"role": "user", "content": "same"}], schema=Out),
                            range(6)))
    assert gw.adapter.calls == {"same": 1} and len(list(tmp_path.rglob("*.json"))) == 1
    assert sorted(r.cached for r in out) == [False] + [True] * 5
    assert not gw._inflight                                         # nothing left in the in-flight table


def test_parallel_embed_calls_and_usage_summary(tmp_path):
    gw = parallel_gateway(tmp_path, SlowAdapter())
    with ThreadPoolExecutor(max_workers=4) as pool:
        vectors = list(pool.map(lambda i: gw.embed([f"text {i}", "x"]), range(4)))
    assert vectors == [[[float(len(f"text {i}"))], [1.0]] for i in range(4)]
    for i in range(3):
        gw.complete("writer", [{"role": "user", "content": f"q{i}"}], schema=Out)
    gw.complete("writer", [{"role": "user", "content": "q0"}], schema=Out)       # cached: not counted as usage
    assert gw.usage_summary() == {"calls": 4, "live_calls": 3, "prompt_tokens": 30, "completion_tokens": 6,
                                  "thinking_tokens": 0, "cached_tokens": 12, "cached_prompt_share": 0.4}


def test_local_minute_limit_makes_calls_wait_without_rate_limit_headers(tmp_path):
    slept = []
    profile = Profile(name="lim", adapter="fake", base_url="", api_key_env="X", limits={"minute": 2},
                      roles={"writer": RoleConfig(models=["m1"])})
    clock = [0.0]
    budget = BudgetMeter(profile.limits, clock=lambda: clock[0])
    gw = LLMGateway(profile, SlowAdapter(delay=0), LLMCache(tmp_path), budget, sleep=lambda s: (slept.append(s),
                    clock.__setitem__(0, clock[0] + s)))
    for i in range(3):
        gw.complete("writer", [{"role": "user", "content": f"q{i}"}], schema=Out)
    assert slept == [pytest.approx(60.0)]                           # the third call waited for the window to move
    gw.complete("writer", [{"role": "user", "content": "q0"}], schema=Out)      # cached: no slot needed
    assert slept == [pytest.approx(60.0)]


def test_embed_retries_after_rate_limit_then_falls_back(tmp_path):
    class Flaky:
        def __init__(self):
            self.seen = []

        def embed(self, model, texts):
            self.seen.append(model)
            if model == "e1":
                raise RateLimited(2.0)
            return [[1.0] for _ in texts]

    profile = Profile(name="emb", adapter="fake", base_url="", api_key_env="X",
                      roles={"embedder": RoleConfig(models=["e1", "e2"])})
    slept = []
    gw = LLMGateway(profile, Flaky(), LLMCache(tmp_path), sleep=slept.append)
    assert gw.embed(["a", "b"]) == [[1.0], [1.0]]
    assert gw.adapter.seen == ["e1", "e1", "e1", "e2"] and slept == [2.0, 2.0, 2.0]


def test_tool_call_extra_content_survives_the_run_tools_loop(tmp_path):
    call = ToolCall(id="c1", name="convert_units", arguments='{"value": 4000}',
                    extra_content={"google": {"thought_signature": "c2ln"}})
    gw, _ = make(tmp_path, [resp("", calls=[call]), resp("done")])
    tool = ToolSpec("convert_units", "convert", {"type": "object"}, lambda a: {"ok": True})
    gw.run_tools("generator", [{"role": "user", "content": "go"}], [tool])
    sent = gw.adapter.requests[1].messages[1]["tool_calls"][0]
    assert sent["extra_content"] == {"google": {"thought_signature": "c2ln"}} and sent["id"] == "c1"
    again = LLMResponse.from_dict(resp("", calls=[call]).to_dict())      # survives the cache round trip
    assert again.tool_calls[0].extra_content == call.extra_content
    assert LLMResponse.from_dict({"text": "x", "finish_reason": "stop", "model": "m",
                                  "tool_calls": [{"id": "1", "name": "n", "arguments": "{}"}]}).tool_calls[0] \
        .extra_content is None                                      # old cache entries still load


def test_a_model_without_quota_is_skipped_on_later_calls(tmp_path):
    from prism.llm.adapters.base import QuotaExhausted
    gw, _ = make(tmp_path, [QuotaExhausted("daily quota"), resp('{"answer": "a"}', model="m2"),
                            resp('{"answer": "b"}', model="m2")])
    gw.complete("generator", [{"role": "user", "content": "q1"}], schema=Out)
    assert gw.complete("generator", [{"role": "user", "content": "q2"}], schema=Out).parsed.answer == "b"
    assert [r.model for r in gw.adapter.requests] == ["m1", "m2", "m2"]          # m1 is not asked again


def test_when_every_model_rests_they_are_tried_anyway(tmp_path):
    from prism.llm.adapters.base import QuotaExhausted
    gw, _ = make(tmp_path, [QuotaExhausted("a"), QuotaExhausted("b"), resp('{"answer": "ok"}')])
    with pytest.raises(LLMUnavailable):
        gw.complete("generator", [{"role": "user", "content": "q1"}], schema=Out)
    assert gw.complete("generator", [{"role": "user", "content": "q2"}], schema=Out).parsed.answer == "ok"
