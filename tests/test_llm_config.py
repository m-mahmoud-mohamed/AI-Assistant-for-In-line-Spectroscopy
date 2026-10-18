import pytest

from prism.llm.budget import BudgetMeter
from prism.llm.cache import LLMCache, ReplayMiss
from prism.llm.profiles import LEGACY_ROLES, ROLES, Profile, RoleConfig, expand_env, load_profile


def test_gwdg_profile_loads_with_roles(monkeypatch):
    monkeypatch.delenv("PRISM_LLM_PROFILE", raising=False)
    p = load_profile()
    assert p.name == "gwdg" and p.adapter == "openai_compatible"
    assert p.role("writer").models[0] == "qwen3.5-397b-a17b" and p.role("writer").max_tokens == 1500
    assert p.role("judge").models[0] == "deepseek-v4-flash-0731" and p.role("judge").reasoning == "off"
    assert p.role("judge_deep").models[0] == "deepseek-v4-flash-0731"
    assert p.role("patcher").models[0] == "qwen3-30b-a3b-instruct-2507"
    assert p.role("extractor").reasoning == "off"
    assert p.capabilities["qwen3.5-397b-a17b"]["thinking_toggle"] is True


@pytest.mark.parametrize("name", ["gwdg", "gemini"])
def test_profiles_define_all_ten_roles(name):
    p = load_profile(name=name)
    for role in ROLES:
        assert p.role(role).models, role
    # the judge must not be the writer's family or model, so the checker does not share the writer's blind spots
    assert p.role("judge").models[0] != p.role("writer").models[0]
    if name == "gwdg":
        assert p.role("judge").models[0].split("-")[0] != p.role("writer").models[0].split("-")[0]


def test_default_profile_is_gwdg_not_gemini(monkeypatch):
    monkeypatch.delenv("PRISM_LLM_PROFILE", raising=False)
    assert load_profile().name == "gwdg"
    monkeypatch.setenv("PRISM_LLM_PROFILE", "gemini")
    assert load_profile().name == "gemini"


def test_gemini_profile_matches_the_routing_table(monkeypatch):
    p = load_profile(name="gemini")
    assert p.adapter == "gemini" and p.api_key_env == "GEMINI_API_KEY" and p.limits == {}
    mid, fast, top = ["gemini-3.8-flash", "gemini-3.6-flash"], ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"], \
        ["gemini-4-argon", "gemini-3.1-pro-preview", "gemini-3.8-flash"]      # flash: keys without top-tier quota
    assert [p.role(r).models for r in ("agent", "extractor", "writer")] == [mid] * 3
    assert [p.role(r).models for r in ("judge", "patcher", "classifier")] == [fast] * 3
    assert [p.role(r).models for r in ("writer_deep", "judge_deep")] == [top] * 2
    assert p.role("vision").models == ["gemini-4-argon", "gemini-3.8-flash"]
    assert p.role("embedder").models == ["gemini-embedding-001"]
    assert {r: p.role(r).max_tokens for r in ("writer", "extractor", "agent", "judge", "patcher", "classifier",
                                               "writer_deep", "judge_deep")} == {
        "writer": 1500, "extractor": 3000, "agent": 2000, "judge": 1500, "patcher": 1500, "classifier": 300,
        "writer_deep": 8000, "judge_deep": 8000}
    assert all(p.role(r).reasoning == "low" for r in ("agent", "extractor", "writer", "judge", "patcher", "classifier"))
    assert all(p.role(r).reasoning == "high" for r in ("writer_deep", "judge_deep"))
    used = {m for r in ROLES if r != "embedder" for m in p.role(r).models}
    assert used <= set(p.capabilities)
    assert all(p.capabilities[m]["json_schema"] and p.capabilities[m]["tools"] for m in used)


def test_legacy_role_names_resolve_both_ways():
    new_only = Profile("t", "fake", "", "X", roles={"writer": RoleConfig(models=["w"]),
                                                    "judge_deep": RoleConfig(models=["jd"])})
    assert new_only.role("generator").models == ["w"] and new_only.role("critic_deep").models == ["jd"]
    old_only = Profile("t", "fake", "", "X", roles={"generator_deep": RoleConfig(models=["gd"]),
                                                    "critic": RoleConfig(models=["c"])})
    assert old_only.role("writer_deep").models == ["gd"] and old_only.role("judge").models == ["c"]
    both = Profile("t", "fake", "", "X", roles={"writer": RoleConfig(models=["new"]),
                                                "generator": RoleConfig(models=["old"])})
    assert both.role("writer").models == ["new"] and both.role("generator").models == ["old"]
    assert set(LEGACY_ROLES.values()) <= set(ROLES)
    with pytest.raises(KeyError):
        old_only.role("patcher")                      # no legacy name: a profile must configure it


def test_legacy_names_work_on_the_shipped_profiles():
    for name in ("gwdg", "gemini"):
        p = load_profile(name=name)
        assert p.role("generator") is p.role("writer") and p.role("critic_deep") is p.role("judge_deep")
        assert p.roles["generator"].models == p.roles["writer"].models


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


def test_budget_counts_locally_when_the_provider_sends_no_headers():
    now = [0.0]
    b = BudgetMeter({"minute": 2, "day": 3}, clock=lambda: now[0])
    assert b.reserve() == 0 and b.reserve() == 0
    assert b.reserve() == pytest.approx(60.0)          # third call in the same minute must wait
    now[0] = 61.0
    assert b.reserve() == 0                            # the window moved on
    snap = b.snapshot()
    assert snap["remaining"]["day"] == 0 and snap["remaining"]["hour"] is None and snap["total_calls"] == 3
    assert not b.can_afford(1)                         # the day allowance is used up
    assert BudgetMeter().reserve() == 0                # no limits at all (gemini profile): never blocks


def test_budget_header_wait_is_served_once():
    now = [0.0]
    b = BudgetMeter({}, clock=lambda: now[0])
    b.update_from_headers({"x-ratelimit-remaining-minute": "0", "ratelimit-reset": "5"})
    assert b.reserve() == pytest.approx(5.0)
    now[0] = 2.0
    assert b.reserve() == pytest.approx(3.0)
    now[0] = 5.5
    assert b.reserve() == 0 and b.wait_seconds() == 0


def test_cache_corrupt_entry_is_a_miss_and_tmp_files_do_not_linger(tmp_path):
    cache = LLMCache(tmp_path)
    key = "ab" + "0" * 62
    path = tmp_path / "ab" / f"{key}.json"
    path.parent.mkdir(parents=True)
    path.write_text("{truncated", encoding="utf-8")
    assert cache.get(key) is None
    cache.put(key, {"text": "ok"})
    assert cache.get(key) == {"text": "ok"} and [f.name for f in path.parent.iterdir()] == [path.name]
    assert cache.stats() == {"hits": 1, "misses": 1, "writes": 1}
