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
                    import onnxruntime as rt
                    from kokoro_onnx import Kokoro

                    # ONNX Runtime sizes its thread pool from the machine's core
                    # count, which inside a container is the *host's* - far more
                    # than the vCPUs we actually get. The resulting
                    # oversubscription makes inference several times slower, so
                    # pin the pool to our real CPU allocation.
                    options = rt.SessionOptions()
                    options.intra_op_num_threads = self._threads()
                    options.inter_op_num_threads = 1
                    session = rt.InferenceSession(
                        self._settings.kokoro_model_path,
                        sess_options=options,
                        providers=["CPUExecutionProvider"],
                    )
                    self._kokoro = Kokoro.from_session(
                        session, self._settings.kokoro_voices_path
                    )
        return self._kokoro

    def _threads(self) -> int:
        configured = self._settings.onnx_intra_op_threads
        if configured > 0:
            return configured
        # cgroup quota reflects the container's real CPU limit; os.cpu_count()
        # does not.
        return max(1, _cgroup_cpu_limit() or os.cpu_count() or 1)

    def synthesize(self, text: str, voice: str | None = None) -> TTSResult:
        kokoro = self._ensure_model()
        samples, sample_rate = kokoro.create(
            text,
            voice=voice or self._settings.tts_voice,
            speed=1.0,
            lang=self._settings.kokoro_lang,
        )
        return TTSResult(audio=_float_to_wav(samples, sample_rate), mime="audio/wav")


def _cgroup_cpu_limit() -> int | None:
    """CPU limit granted to this container, or None outside a limited cgroup."""
    try:  # cgroup v2
        with open("/sys/fs/cgroup/cpu.max") as fh:
            quota, period = fh.read().split()
        if quota != "max":
            return max(1, round(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    try:  # cgroup v1
        with open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") as fh:
            quota = int(fh.read())
        with open("/sys/fs/cgroup/cpu/cpu.cfs_period_us") as fh:
            period = int(fh.read())
        if quota > 0 and period > 0:
            return max(1, round(quota / period))
    except (OSError, ValueError):
        pass
    return None


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
