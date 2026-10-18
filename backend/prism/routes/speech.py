"""API routes: speech. Shared services (store, kb, gateway) are on `request.app.state`."""
from __future__ import annotations

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from prism.llm.adapters.base import TranscriptionUnavailable

router = APIRouter()

MAX_AUDIO_BYTES = 20 * 1024 * 1024
ALLOWED_TYPES = {"audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"}


@router.post("/api/speech/transcribe")
async def transcribe(request: Request, audio: Annotated[UploadFile, File()],
                     language: Annotated[Literal["auto", "en", "ar"], Form()] = "auto") -> dict:
    try:
        mime = (audio.content_type or "").split(";")[0].strip().lower()
        if mime not in ALLOWED_TYPES:
            raise HTTPException(415, "Unsupported audio type. Record WebM, Ogg, MP4, MP3 or WAV audio.")
        data = await audio.read(MAX_AUDIO_BYTES + 1)
        if len(data) > MAX_AUDIO_BYTES:
            raise HTTPException(413, "Audio must be 20 MB or smaller.")
        if not data:
            raise HTTPException(400, "The recording is empty.")
        gateway = request.app.state.gateway
        if gateway is None or not callable(getattr(gateway, "transcribe", None)):
            raise HTTPException(501, "No transcriber is configured for the active profile.")
        try:
            result = await asyncio.wait_for(asyncio.to_thread(gateway.transcribe, data, mime, language), timeout=60)
        except TranscriptionUnavailable as e:
            raise HTTPException(501, str(e)) from e
        except TimeoutError as e:
            raise HTTPException(504, "Transcription timed out. Please try a shorter recording.") from e
        except Exception as e:
            # Provider messages can contain credentials or request details; never expose them.
            raise HTTPException(502, "Transcription failed. Please try again.") from e
        if not result.text.strip():
            raise HTTPException(422, "No speech was detected. Please try again.")
        return {"text": result.text, "language": result.language}
    finally:
        await audio.close()
