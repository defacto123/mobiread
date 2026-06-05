"""Offline mock TTS engine for local development and end-to-end testing.

Generates a quiet sine-tone WAV roughly proportional to the input length
(~0.38s per word), so the full pipeline - upload, synthesis, alignment, and the
frontend karaoke player - can be exercised without a Deep Infra token.

Enable with TTS_ENGINE=mock.
"""

from __future__ import annotations

import io
import math
import struct
import wave

from app.config import Settings
from app.tts.base import TTSEngine, TTSResult

_SAMPLE_RATE = 22050
_SECONDS_PER_WORD = 0.38


class MockTTSEngine(TTSEngine):
    def __init__(self, settings: Settings):
        self._settings = settings

    def synthesize(self, text: str, voice: str | None = None) -> TTSResult:
        num_words = max(1, len(text.split()))
        duration = num_words * _SECONDS_PER_WORD
        num_samples = int(duration * _SAMPLE_RATE)

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(_SAMPLE_RATE)
            frames = bytearray()
            for n in range(num_samples):
                # Quiet 220 Hz tone with gentle amplitude envelope.
                sample = 0.05 * math.sin(2 * math.pi * 220 * (n / _SAMPLE_RATE))
                frames += struct.pack("<h", int(sample * 32767))
            wf.writeframes(bytes(frames))

        return TTSResult(audio=buf.getvalue(), mime="audio/wav")
