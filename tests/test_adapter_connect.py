"""A connect that hangs or is refused is sent again; a request that reached the server is not."""
from __future__ import annotations

import httpx
import openai
import pytest

from prism.llm.adapters.base import CONNECT_RETRIES, LLMRequest, ProviderError, retry_connect
from prism.llm.adapters.openai_compat import OpenAICompatibleAdapter

REQ = httpx.Request("POST", "https://llm.example/v1/chat/completions")


def _raise(err: Exception, cause: Exception):
    raise err from cause


def connect_timeout():
    _raise(openai.APITimeoutError(request=REQ), httpx.ConnectTimeout("connect hung"))


def read_timeout():
    _raise(openai.APITimeoutError(request=REQ), httpx.ReadTimeout("slow answer"))


class Completions:
    def __init__(self, fail):
        self.fail, self.calls = fail, 0
        self.with_raw_response = self

    def create(self, **kw):
        self.calls += 1
        self.fail()


class Client:
    def __init__(self, fail):
        self.chat = type("Chat", (), {})()
        self.chat.completions = Completions(fail)


def test_retry_connect_returns_after_connect_failures():
    calls = []

    def send():
        calls.append(1)
        if len(calls) <= CONNECT_RETRIES:
            connect_timeout()
        return "ok"

    assert retry_connect(send) == "ok"
    assert len(calls) == CONNECT_RETRIES + 1


def test_retry_connect_does_not_resend_after_the_server_got_the_request():
    calls = []

    def send():
        calls.append(1)
        read_timeout()

    with pytest.raises(openai.APITimeoutError):
        retry_connect(send)
    assert len(calls) == 1


@pytest.mark.parametrize("fail, sent", [(connect_timeout, CONNECT_RETRIES + 1), (read_timeout, 1)])
def test_openai_adapter_gives_up_with_provider_error(fail, sent):
    client = Client(fail)
    adapter = OpenAICompatibleAdapter(base_url="", api_key="k", client=client)
    with pytest.raises(ProviderError):
        adapter.complete(LLMRequest(model="m", messages=[{"role": "user", "content": "hi"}]))
    assert client.chat.completions.calls == sent


def test_openai_reasoning_models_get_their_token_parameter_effort_and_headroom():
    cap = {"m": {"max_tokens_param": "max_completion_tokens", "reasoning_effort": True, "reasoning_off": "none",
                 "reasoning_headroom": {"none": 0, "low": 2048, "high": 8192}}}
    adapter = OpenAICompatibleAdapter(base_url="", api_key="k", capabilities=cap, client=Client(lambda: None))
    req = lambda reasoning: LLMRequest(model="m", messages=[], reasoning=reasoning, max_tokens=1000,
                                       temperature=None)
    off, low, high = adapter._kwargs(req("off")), adapter._kwargs(req("low")), adapter._kwargs(req("high"))
    assert off["reasoning_effort"] == "none" and off["max_completion_tokens"] == 1000 and "max_tokens" not in off
    assert low["reasoning_effort"] == "low" and low["max_completion_tokens"] == 3048
    assert high["max_completion_tokens"] == 9192 and "temperature" not in high


def test_other_openai_compatible_models_keep_max_tokens_and_no_effort():
    adapter = OpenAICompatibleAdapter(base_url="", api_key="k", capabilities={}, client=Client(lambda: None))
    kw = adapter._kwargs(LLMRequest(model="qwen", messages=[], reasoning="off", max_tokens=500))
    assert kw["max_tokens"] == 500 and "reasoning_effort" not in kw and "max_completion_tokens" not in kw


def test_the_openai_profile_routes_every_role():
    from prism.llm.profiles import ROLES, load_profile
    p = load_profile(name="openai")
    assert p.api_key_env == "OPENAI_API_KEY" and all(p.role(r).models for r in ROLES)
    assert p.role("judge").models[0] != p.role("writer").models[0]          # the checker is not the writer
    assert p.role("transcriber").models[0] == "gpt-4o-transcribe"
