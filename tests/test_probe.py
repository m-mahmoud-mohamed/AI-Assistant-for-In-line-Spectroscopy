import importlib.util
from pathlib import Path

from prism.llm.adapters.base import LLMResponse, ToolCall
from prism.llm.budget import BudgetMeter
from prism.llm.cache import LLMCache
from prism.llm.gateway import LLMGateway
from prism.llm.profiles import Profile, RoleConfig

spec = importlib.util.spec_from_file_location("probe_llm", Path(__file__).resolve().parents[1] / "scripts/probe_llm.py")
probe_llm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe_llm)


class Adapter:
    def complete(self, req):
        if req.tools:
            return LLMResponse("", "tool_calls", req.model, tool_calls=[ToolCall("1", "convert_units", "{}")])
        return LLMResponse('{"ok": true}', "stop", req.model, headers={"x-ratelimit-remaining-month": "2990"})

    def embed(self, model, texts):
        return [[0.1, 0.2, 0.3]]


def test_probe_reports_capabilities(tmp_path):
    profile = Profile("t", "fake", "", "X", roles={"generator": RoleConfig(models=["m1"]),
                                                   "embedder": RoleConfig(models=["e1"])})
    gw = LLMGateway(profile, Adapter(), LLMCache(tmp_path), BudgetMeter())
    report = probe_llm.probe(gw)
    assert report["models"]["m1"] == {"json_schema": True, "tools": True}
    assert report["embeddings"]["e1"] == 3
    assert report["limits"]["remaining"]["month"] == 2990
