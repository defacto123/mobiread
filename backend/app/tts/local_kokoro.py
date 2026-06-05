"""Self-hosted Kokoro-82M text-to-speech via ONNX Runtime (CPU).

Runs the open Kokoro model inside our own Cloud Run container - no third-party
API, no per-character billing, no GPU. Model files (`kokoro-v1.0.onnx` and
`voices-v1.0.bin`) are baked into the image at build time so there is no
cold-start download.

Enable with TTS_ENGINE=local_kokoro.
"""

from __future__ import annotations

import io
import os
import threading
import wave

import numpy as np

from app.config import Settings
from app.tts.base import TTSEngine, TTSResult


class LocalKokoroEngine(TTSEngine):
    def __init__(self, settings: Settings):
        self._settings = settings
        self._kokoro = None
        self._lock = threading.Lock()

        for path in (settings.kokoro_model_path, settings.kokoro_voices_path):
            if not os.path.exists(path):
                raise RuntimeError(
                    f"Kokoro model file not found: {path}. "
                    "It should be baked into the image (see backend/Dockerfile)."
                )

    def _ensure_model(self):
        # Lazy, thread-safe load: importing/loading ONNX is expensive, so do it
        # once on first request rather than at import time.
        if self._kokoro is None:
            with self._lock:
                if self._kokoro is None:
                    from kokoro_onnx import Kokoro

                    self._kokoro = Kokoro(
                        self._settings.kokoro_model_path,
                        self._settings.kokoro_voices_path,
                    )
        return self._kokoro

    def synthesize(self, text: str, voice: str | None = None) -> TTSResult:
        kokoro = self._ensure_model()
        samples, sample_rate = kokoro.create(
            text,
            voice=voice or self._settings.tts_voice,
            speed=1.0,
            lang=self._settings.kokoro_lang,
        )
        return TTSResult(audio=_float_to_wav(samples, sample_rate), mime="audio/wav")


def _float_to_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode a float32 [-1, 1] mono waveform as 16-bit PCM WAV bytes."""
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()
