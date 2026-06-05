"""TTS engine abstraction.

All synthesis goes through the `TTSEngine` interface so the underlying provider
(managed Kokoro on Deep Infra today; self-hosted Kokoro/Higgs or another vendor
tomorrow) can be swapped by changing one env var and adding one implementation,
without touching the API or frontend.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.config import Settings


@dataclass
class TTSResult:
    audio: bytes
    mime: str  # e.g. "audio/wav"


class TTSEngine(ABC):
    @abstractmethod
    def synthesize(self, text: str, voice: str | None = None) -> TTSResult:
        """Convert `text` to speech audio. Returns raw audio bytes + mime type."""
        raise NotImplementedError


def get_engine(settings: Settings) -> TTSEngine:
    """Factory selecting the configured TTS engine."""
    engine = settings.tts_engine.lower()
    if engine == "local_kokoro":
        from app.tts.local_kokoro import LocalKokoroEngine

        return LocalKokoroEngine(settings)
    if engine == "deepinfra_kokoro":
        from app.tts.deepinfra_kokoro import DeepInfraKokoroEngine

        return DeepInfraKokoroEngine(settings)
    if engine == "mock":
        from app.tts.mock import MockTTSEngine

        return MockTTSEngine(settings)
    raise ValueError(f"Unknown TTS_ENGINE: {settings.tts_engine!r}")
