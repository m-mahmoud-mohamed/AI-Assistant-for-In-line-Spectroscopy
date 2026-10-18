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
