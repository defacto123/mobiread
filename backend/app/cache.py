"""In-memory cache of synthesized chunk audio + word timings.

Synthesis is the expensive part of a request (seconds of CPU), while serving a
cached chunk is essentially free. Caching is what makes arbitrary seeking fast:
once a chunk has been generated - on demand or by the pre-warmer - jumping back
to it costs nothing.

Entries are capped by total audio bytes (not entry count) because chunk sizes
vary, and evicted least-recently-used first. Audio is uncompressed WAV
(~48 KB/s), so the cap is what keeps a long book from exhausting the instance.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass

from app.models import WordTiming

CacheKey = tuple[str, int, str]


@dataclass
class CachedChunk:
    audio: bytes
    mime: str
    duration: float
    words: list[WordTiming]

    @property
    def nbytes(self) -> int:
        return len(self.audio)


class AudioCache:
    def __init__(self, max_bytes: int):
        self._items: OrderedDict[CacheKey, CachedChunk] = OrderedDict()
        self._lock = threading.Lock()
        self._max_bytes = max_bytes
        self._bytes = 0

    def get(self, key: CacheKey) -> CachedChunk | None:
        with self._lock:
            item = self._items.get(key)
            if item is not None:
                self._items.move_to_end(key)
            return item

    def has(self, key: CacheKey) -> bool:
        with self._lock:
            return key in self._items

    def put(self, key: CacheKey, chunk: CachedChunk) -> None:
        with self._lock:
            existing = self._items.pop(key, None)
            if existing is not None:
                self._bytes -= existing.nbytes
            self._items[key] = chunk
            self._bytes += chunk.nbytes
            while self._bytes > self._max_bytes and len(self._items) > 1:
                _, evicted = self._items.popitem(last=False)
                self._bytes -= evicted.nbytes

    def count_cached(self, doc_id: str, voice: str, indices: list[int]) -> int:
        with self._lock:
            return sum(1 for i in indices if (doc_id, i, voice) in self._items)

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {"entries": len(self._items), "bytes": self._bytes}
