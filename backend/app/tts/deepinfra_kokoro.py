"""Kokoro-82M text-to-speech via the Deep Infra managed inference API.

Kokoro is a lightweight (82M) Apache-2.0 open model. Using it through Deep Infra
keeps our Cloud Run service CPU-only (no GPU) while remaining swappable: a future
self-hosted engine just needs to implement `TTSEngine`.
"""

from __future__ import annotations

import requests

from app.config import Settings
from app.tts.base import TTSEngine, TTSResult


class DeepInfraKokoroEngine(TTSEngine):
    def __init__(self, settings: Settings):
        if not settings.deepinfra_token:
            raise RuntimeError(
                "DEEPINFRA_TOKEN is not set. Provide it via environment or Secret Manager."
            )
        self._settings = settings
        self._url = f"{settings.deepinfra_base_url}/{settings.tts_model}"
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {settings.deepinfra_token}",
                "Content-Type": "application/json",
            }
        )

    def synthesize(self, text: str, voice: str | None = None) -> TTSResult:
        payload = {
            "text": text,
            "preset_voice": voice or self._settings.tts_voice,
            "output_format": "wav",
        }
        resp = self._session.post(
            self._url,
            json=payload,
            timeout=self._settings.request_timeout_seconds,
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"Deep Infra TTS failed ({resp.status_code}): {resp.text[:300]}"
            )

        content_type = resp.headers.get("Content-Type", "")
        if content_type.startswith("application/json"):
            # Some Deep Infra models return JSON with a base64 audio field.
            data = resp.json()
            audio_b64 = data.get("audio") or data.get("output")
            if not audio_b64:
                raise RuntimeError(f"Unexpected Deep Infra JSON response: {data}")
            import base64

            return TTSResult(audio=base64.b64decode(audio_b64), mime="audio/wav")

        return TTSResult(audio=resp.content, mime=content_type or "audio/wav")
