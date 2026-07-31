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

# Extra "duration weight" (in phoneme-equivalent units) added to a word that
# ends in punctuation, because the TTS audibly pauses there.
_PAUSE_COMMA = 3.0  # , ; :
_PAUSE_SENTENCE = 6.0  # . ! ? …

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

    return duration, _align_proportional(audio, text, duration, settings)


def _speech_span(audio: bytes, duration: float) -> tuple[float, float]:
    """Return the (start, end) seconds of the non-silent region of the audio.

    TTS clips usually have a short leading/trailing silence; distributing word
    timings across the *speech* span (instead of the whole clip) removes the
    systematic bias where the karaoke marker lands a bit before each word.
    Falls back to (0, duration) if the audio can't be analyzed.
    """
    try:
        import numpy as np

        with wave.open(io.BytesIO(audio), "rb") as wf:
            n_frames = wf.getnframes()
            rate = wf.getframerate()
            channels = wf.getnchannels()
            sample_width = wf.getsampwidth()
            raw = wf.readframes(n_frames)
        if sample_width != 2 or rate <= 0 or n_frames == 0:
            return 0.0, duration

        samples = np.frombuffer(raw, dtype=np.int16)
        if channels > 1:
            samples = samples.reshape(-1, channels).mean(axis=1)
        amp = np.abs(samples.astype(np.float32))
        if amp.size == 0:
            return 0.0, duration
        peak = float(amp.max())
        if peak <= 0:
            return 0.0, duration

        loud = np.where(amp > peak * 0.02)[0]
        if loud.size == 0:
            return 0.0, duration
        start = float(loud[0]) / rate
        end = float(loud[-1] + 1) / rate
        return start, end
    except Exception:
        return 0.0, duration


def _phonemize_words(words: list[str], lang: str) -> list[str] | None:
    """Phonemize each word so timing weights track *spoken* length (phoneme
    count) rather than character count. Returns None if espeak/phonemizer is
    unavailable, so the caller can fall back to character-based weights."""
    try:
        import phonemizer

        result = phonemizer.phonemize(
            words,
            language=lang,
            backend="espeak",
            preserve_punctuation=True,
            with_stress=True,
        )
        if isinstance(result, str):
            return [result]
        return list(result)
    except Exception as exc:
        logger.info("Per-word phonemization unavailable, using char weights: %s", exc)
        return None


def _align_proportional(
    audio: bytes,
    text: str,
    duration: float,
    settings: Settings,
) -> list[WordTiming]:
    words = _WORD_RE.findall(text)
    if not words:
        return []
    if duration <= 0:
        # Unknown duration: assume an average speaking rate (~3 words/sec).
        duration = len(words) / 3.0

    speech_start, speech_end = _speech_span(audio, duration)
    if speech_end <= speech_start:
        speech_start, speech_end = 0.0, duration
    span_total = speech_end - speech_start

    lang = getattr(settings, "kokoro_lang", None) or "en-us"
    phonemes = _phonemize_words(words, lang)

    weights: list[float] = []
    for i, word in enumerate(words):
        if phonemes and i < len(phonemes):
            base = float(len([c for c in phonemes[i] if not c.isspace()])) or 1.0
        else:
            base = float(len(word))
        last = word[-1]
        if last in ",;:":
            base += _PAUSE_COMMA
        elif last in ".!?…":
            base += _PAUSE_SENTENCE
        weights.append(base + 1.0)

    total = float(sum(weights)) or 1.0
    timings: list[WordTiming] = []
    cursor = speech_start
    for word, weight in zip(words, weights):
        span = span_total * (weight / total)
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
