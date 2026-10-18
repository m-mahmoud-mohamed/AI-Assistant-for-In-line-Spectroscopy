"""Speech stays offline in tests: multipart validation, role routing and provider request shapes."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.genai import types

from prism.llm.adapters.base import ProviderError, Transcription, TranscriptionUnavailable
from prism.llm.adapters.gemini import GeminiAdapter
from prism.llm.adapters.openai_compat import OpenAICompatibleAdapter
from prism.llm.cache import LLMCache
from prism.llm.gateway import LLMGateway, LLMUnavailable
from prism.llm.profiles import Profile, RoleConfig, load_profile
from prism.routes.speech import router
from tests.fakes import FakeGateway


def client(gateway):
    app = FastAPI()
    app.state.gateway = gateway
    app.include_router(router)
    return TestClient(app)


def test_transcribe_route_preserves_arabic_and_language():
    gateway = FakeGateway({"transcriber": [{"text": "قياس الماء", "language": "ar"}]})
    response = client(gateway).post("/api/speech/transcribe", files={"audio": ("a.webm", b"audio", "audio/webm;codecs=opus")},
                                    data={"language": "auto"})
    assert response.status_code == 200 and response.json() == {"text": "قياس الماء", "language": "ar"}
    assert gateway.requests == [{"role": "transcriber", "audio": b"audio", "mime": "audio/webm", "language": "auto"}]


@pytest.mark.parametrize(("content", "mime", "language", "status"), [
    (b"a", "text/plain", "auto", 415), (b"", "audio/webm", "auto", 400),
    (b"a", "audio/webm", "fr", 422), (b"x" * (20 * 1024 * 1024 + 1), "audio/webm", "en", 413),
])
def test_invalid_upload_never_reaches_gateway(content, mime, language, status):
    gateway = FakeGateway()
    response = client(gateway).post("/api/speech/transcribe", files={"audio": ("a", content, mime)}, data={"language": language})
    assert response.status_code == status and gateway.requests == []


@pytest.mark.parametrize(("gateway", "status"), [
    (None, 501), (FakeGateway({"transcriber": [TranscriptionUnavailable("No transcriber configured")]}), 501),
    (FakeGateway({"transcriber": [RuntimeError("private provider detail")]}), 502),
    (FakeGateway({"transcriber": [{"text": "", "language": "en"}]}), 422),
])
def test_speech_errors_are_clear_and_private(gateway, status):
    response = client(gateway).post("/api/speech/transcribe", files={"audio": ("a", b"audio", "audio/wav")})
    assert response.status_code == status
    assert "private provider detail" not in response.text


def test_route_timeout_is_bounded(monkeypatch):
    async def timeout(awaitable, timeout):
        awaitable.close()
        raise TimeoutError
    monkeypatch.setattr("prism.routes.speech.asyncio.wait_for", timeout)
    response = client(FakeGateway()).post("/api/speech/transcribe", files={"audio": ("a", b"audio", "audio/wav")})
    assert response.status_code == 504


def test_openai_audio_request_and_auto_language():
    create = Mock(return_value=SimpleNamespace(text="مرحبا"))
    fake = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    adapter = OpenAICompatibleAdapter("", "", client=fake)
    assert adapter.transcribe("whisper-custom", b"voice", "audio/mp4", "auto") == Transcription("مرحبا", "ar")
    create.assert_called_once_with(model="whisper-custom", file=("recording.mp4", b"voice", "audio/mp4"))
    adapter.transcribe("whisper-custom", b"voice", "audio/webm", "en")
    assert create.call_args.kwargs["language"] == "en"


def test_gemini_audio_uses_inline_bytes_and_verbatim_prompt():
    response = types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(parts=[types.Part(text="Water content")]))])
    generate = Mock(return_value=response)
    adapter = GeminiAdapter("", client=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))
    assert adapter.transcribe("flash", b"voice", "audio/webm", "auto") == Transcription("Water content", "en")
    request = generate.call_args.kwargs
    assert request["model"] == "flash"
    parts = request["contents"][0].parts
    assert "Transcribe verbatim; keep the language (English or Arabic)" in parts[0].text
    assert parts[1].inline_data.data == b"voice" and parts[1].inline_data.mime_type == "audio/webm"


def test_gateway_routing_fallback_and_no_audio_disk_cache(tmp_path):
    adapter = Mock()
    adapter.transcribe.side_effect = [ProviderError("failed"), Transcription("Water", "en")]
    profile = Profile("fake", "fake", "", "X", roles={"transcriber": RoleConfig(["first", "second"])})
    gateway = LLMGateway(profile, adapter, LLMCache(tmp_path))
    assert gateway.transcribe(b"audio", "audio/wav").text == "Water"
    assert adapter.transcribe.call_args_list[1].args[0] == "second"
    assert list(tmp_path.iterdir()) == []
    assert gateway.calls[0]["role"] == "transcriber" and "audio" not in str(gateway.calls)
    adapter.transcribe.side_effect = ProviderError("private detail")
    with pytest.raises(LLMUnavailable, match="Audio transcription failed"):
        gateway.transcribe(b"audio", "audio/wav")


def test_unconfigured_and_replay_profiles_never_call_provider(tmp_path):
    adapter = Mock()
    for roles, replay in [({}, False), ({"transcriber": RoleConfig([])}, False), ({"transcriber": RoleConfig(["audio"])}, True)]:
        gateway = LLMGateway(Profile("fake", "fake", "", "X", roles=roles), adapter, LLMCache(tmp_path, replay=replay))
        with pytest.raises(TranscriptionUnavailable):
            gateway.transcribe(b"audio", "audio/wav")
    adapter.transcribe.assert_not_called()
    assert load_profile(name="gemini").role("transcriber").models
    assert load_profile(name="gwdg").role("transcriber").models == []
