"""Word-level timing for karaoke highlighting.

Two backends:

* ``proportional`` (default): no heavy dependencies. Distributes words across the
  measured audio duration weighted by word length. Good enough for a moving
  karaoke marker and always available.
* ``whisperx``: accurate forced alignment via wav2vec2. Heavier (pulls in torch);
  enabled with ``ALIGN_BACKEND=whisperx`` and the optional requirements file.

Both return ``(duration_seconds, [WordTiming, ...])``. Any failure in the
``whisperx`` path degrades gracefully to the proportional estimate.
"""

from __future__ import annotations

import io
import logging
import re
import wave

from app.config import Settings
from app.models import WordTiming

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"\S+")

# Cache for the (expensive) WhisperX align model, keyed by language.
_whisperx_cache: dict[str, tuple] = {}


def wav_duration(audio: bytes) -> float:
    """Return duration in seconds of a WAV byte string (0.0 if unparseable)."""
    try:
        with wave.open(io.BytesIO(audio), "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            if rate <= 0:
                return 0.0
            return frames / float(rate)
    except (wave.Error, EOFError):
        return 0.0


def align_words(
    audio: bytes,
    text: str,
    settings: Settings,
) -> tuple[float, list[WordTiming]]:
    duration = wav_duration(audio)

    if not settings.enable_alignment:
        return duration, []

    if settings.align_backend.lower() == "whisperx":
        try:
            return _align_whisperx(audio, text, duration, settings)
        except Exception as exc:  # pragma: no cover - depends on optional deps
            logger.warning("WhisperX alignment failed, using proportional: %s", exc)

    return duration, _align_proportional(text, duration)


def _align_proportional(text: str, duration: float) -> list[WordTiming]:
    words = _WORD_RE.findall(text)
    if not words:
        return []
    if duration <= 0:
        # Unknown duration: assume an average speaking rate (~3 words/sec).
        duration = len(words) / 3.0

    weights = [len(w) + 1 for w in words]
    total = float(sum(weights))
    timings: list[WordTiming] = []
    cursor = 0.0
    for word, weight in zip(words, weights):
        span = duration * (weight / total)
        start = cursor
        end = cursor + span
        timings.append(WordTiming(word=word, start=round(start, 3), end=round(end, 3)))
        cursor = end
    return timings


def _align_whisperx(
    audio: bytes,
    text: str,
    duration: float,
    settings: Settings,
) -> tuple[float, list[WordTiming]]:  # pragma: no cover - optional heavy path
    import tempfile

    import whisperx

    lang = settings.align_language
    if lang not in _whisperx_cache:
        model, metadata = whisperx.load_align_model(
            language_code=lang, device="cpu"
        )
        _whisperx_cache[lang] = (model, metadata)
    model, metadata = _whisperx_cache[lang]

    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        tmp.write(audio)
        tmp.flush()
        wav = whisperx.load_audio(tmp.name)
        segments = [{"text": text, "start": 0.0, "end": duration or len(text) / 15.0}]
        result = whisperx.align(
            segments, model, metadata, wav, device="cpu", return_char_alignments=False
        )

    timings: list[WordTiming] = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            if w.get("start") is None or w.get("end") is None:
                continue
            timings.append(
                WordTiming(
                    word=w["word"],
                    start=round(float(w["start"]), 3),
                    end=round(float(w["end"]), 3),
                )
            )

    if not timings:
        return duration, _align_proportional(text, duration)
    return duration, timings
