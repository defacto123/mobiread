"""Cache-aware chunk synthesis with foreground priority.

Kokoro on CPU is the scarce resource: a few concurrent synthesis jobs saturate
the cores and every extra job slows all the others down. Two mechanisms keep
user-facing requests fast:

* `PriorityGate` caps total concurrency and reserves capacity for foreground
  (user-initiated) work, so a click never queues behind background pre-warming.
* Per-key de-duplication means repeated requests for the same chunk share one
  synthesis instead of starting competing copies of it.

Results always land in the shared `AudioCache`, so work is never wasted even if
the client that triggered it has already navigated away.
"""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from typing import Iterator

from app.align import align_words
from app.cache import AudioCache, CachedChunk, CacheKey
from app.config import Settings, get_settings
from app.tts import TTSEngine, get_engine

settings: Settings = get_settings()

cache = AudioCache(max_bytes=settings.audio_cache_mb * 1024 * 1024)

_engine: TTSEngine | None = None
_engine_lock = threading.Lock()


def get_tts_engine() -> TTSEngine:
    """Lazily build the TTS engine so the app can boot for health checks even
    before secrets/model files are wired."""
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                _engine = get_engine(settings)
    return _engine


class PriorityGate:
    """Concurrency limiter that lets foreground work jump the queue.

    Background acquirers additionally wait while any foreground acquirer is
    queued, and are limited to `max_background` so a foreground request always
    finds a free slot.
    """

    def __init__(self, max_concurrent: int, max_background: int):
        self._cv = threading.Condition()
        self._max_concurrent = max(1, max_concurrent)
        self._max_background = max(1, min(max_background, self._max_concurrent - 1))
        self._active = 0
        self._active_bg = 0
        self._fg_waiting = 0

    @contextmanager
    def foreground(self) -> Iterator[None]:
        with self._cv:
            self._fg_waiting += 1
            try:
                self._cv.wait_for(lambda: self._active < self._max_concurrent)
            finally:
                self._fg_waiting -= 1
            self._active += 1
        try:
            yield
        finally:
            with self._cv:
                self._active -= 1
                self._cv.notify_all()

    @contextmanager
    def background(self) -> Iterator[None]:
        with self._cv:
            self._cv.wait_for(
                lambda: self._fg_waiting == 0
                and self._active_bg < self._max_background
                and self._active < self._max_concurrent
            )
            self._active += 1
            self._active_bg += 1
        try:
            yield
        finally:
            with self._cv:
                self._active -= 1
                self._active_bg -= 1
                self._cv.notify_all()


gate = PriorityGate(
    max_concurrent=settings.synth_max_concurrency,
    max_background=settings.synth_max_background,
)

_inflight: dict[CacheKey, threading.Event] = {}
_inflight_lock = threading.Lock()

# Wall-clock time of the last foreground synthesis, so background work can keep
# clear of an actively reading user rather than competing with them for CPU.
_last_foreground = 0.0


def note_foreground_activity() -> None:
    global _last_foreground
    _last_foreground = time.monotonic()


def seconds_since_foreground() -> float:
    return time.monotonic() - _last_foreground


def _synthesize_now(text: str, voice: str, key: CacheKey, foreground: bool) -> CachedChunk:
    if foreground:
        note_foreground_activity()
    slot = gate.foreground() if foreground else gate.background()
    with slot:
        if foreground:
            note_foreground_activity()  # refresh after any wait for a slot
        # Another worker may have finished this chunk while we queued for a slot.
        cached = cache.get(key)
        if cached is not None:
            return cached
        result = get_tts_engine().synthesize(text, voice=voice)
        duration, words = align_words(result.audio, text, settings)
        chunk = CachedChunk(
            audio=result.audio, mime=result.mime, duration=duration, words=words
        )
        cache.put(key, chunk)
        return chunk


def get_or_synthesize(
    doc_id: str, index: int, text: str, voice: str, foreground: bool = True
) -> CachedChunk:
    """Return a chunk's audio + timings, synthesizing only if not already cached."""
    key: CacheKey = (doc_id, index, voice)
    cached = cache.get(key)
    if cached is not None:
        return cached

    with _inflight_lock:
        event = _inflight.get(key)
        owner = event is None
        if owner:
            event = threading.Event()
            _inflight[key] = event

    if not owner:
        # Someone else is already synthesizing this exact chunk: wait for them
        # rather than starting a competing job.
        assert event is not None
        event.wait(timeout=settings.request_timeout_seconds)
        cached = cache.get(key)
        if cached is not None:
            return cached
        return _synthesize_now(text, voice, key, foreground)

    try:
        return _synthesize_now(text, voice, key, foreground)
    finally:
        with _inflight_lock:
            _inflight.pop(key, None)
        assert event is not None
        event.set()


def is_cached(doc_id: str, index: int, voice: str) -> bool:
    return cache.has((doc_id, index, voice))
