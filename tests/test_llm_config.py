import pytest

from prism.llm.budget import BudgetMeter
from prism.llm.cache import LLMCache, ReplayMiss
from prism.llm.profiles import expand_env, load_profile


def test_gwdg_profile_loads_with_roles(monkeypatch):
    monkeypatch.delenv("PRISM_LLM_PROFILE", raising=False)
    p = load_profile()
    assert p.name == "gwdg" and p.adapter == "openai_compatible"
    assert p.role("generator").models[0] == "qwen3.5-397b-a17b"
    assert p.role("critic").models[0] == "deepseek-v4-flash-0731"
    assert p.role("extractor").reasoning == "off"
    assert p.capabilities["qwen3.5-397b-a17b"]["thinking_toggle"] is True


def test_unknown_role_raises():
    with pytest.raises(KeyError):
        load_profile().role("poet")


def test_env_expansion(monkeypatch):
    monkeypatch.setenv("X_TEST", "abc")
    assert expand_env("${X_TEST}/v1") == "abc/v1"
    assert expand_env("${NOT_SET_VAR:-fallback}") == "fallback"


def test_cache_roundtrip_and_replay(tmp_path):
    cache = LLMCache(tmp_path)
    key = LLMCache.key({"model": "m", "messages": [{"role": "user", "content": "hi"}]})
    assert cache.get(key) is None
    cache.put(key, {"text": "ok"})
    assert cache.get(key) == {"text": "ok"}
    with pytest.raises(ReplayMiss):
        LLMCache(tmp_path, replay=True).get("0" * 64)


def test_budget_from_headers():
    b = BudgetMeter({"minute": 30})
    b.update_from_headers({"x-ratelimit-remaining-minute": "0", "x-ratelimit-remaining-month": "12",
                           "x-ratelimit-limit-month": "3000", "ratelimit-reset": "16"})
    assert b.wait_seconds() == 16
    assert b.can_afford(10) and not b.can_afford(20)
    assert b.snapshot()["limits"]["month"] == 3000
