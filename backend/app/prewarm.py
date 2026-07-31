"""Background pre-generation of chunk audio.

Seeking is only instant when the target chunk is already synthesized, so a
background worker generates chunks ahead of the reader. The policy is adaptive
because documents differ by orders of magnitude:

* Short documents (papers, articles) are generated in full - a ~50-chunk paper
  finishes in a couple of minutes, after which every position is instant.
* Long documents (books) would need hours of CPU and gigabytes of audio to
  generate in full, so only a rolling window ahead of the reader is generated.
  Jumps outside that window fall back to an on-demand foreground synthesis,
  which is fast because chunks are small and foreground work has priority.

All work runs at background priority, so it always yields to user requests.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field

from app.config import get_settings
from app.store import Document
from app.synth import get_or_synthesize, is_cached, seconds_since_foreground

logger = logging.getLogger("mobiread.prewarm")
settings = get_settings()

WorkerKey = tuple[str, str]  # (doc_id, voice)


@dataclass
class WorkerState:
    doc: Document
    voice: str
    start_index: int = 0
    cancelled: bool = False
    thread: threading.Thread | None = None
    revision: int = 0  # bumped whenever start_index changes, to restart the pass
    _lock: threading.Lock = field(default_factory=threading.Lock)


class PrewarmManager:
    def __init__(self) -> None:
        self._workers: dict[WorkerKey, WorkerState] = {}
        self._lock = threading.Lock()

    def ensure(self, doc: Document, voice: str, start_index: int = 0) -> None:
        """Start (or retarget) background generation for this document + voice."""
        if not settings.prewarm_enabled:
            return
        key: WorkerKey = (doc.doc_id, voice)
        with self._lock:
            # Only one synthesis runs at a time, so any worker other than this
            # one is spending the sole CPU slot on audio nobody is waiting for:
            # a voice the reader switched away from, or a document they left.
            # Park them all; `ensure` revives a worker if the reader returns.
            for other_key, state in self._workers.items():
                if other_key != key:
                    state.cancelled = True

            state = self._workers.get(key)
            if state is None:
                state = WorkerState(doc=doc, voice=voice, start_index=start_index)
                self._workers[key] = state
            else:
                state.cancelled = False

            with state._lock:
                if state.start_index != start_index:
                    state.start_index = start_index
                    state.revision += 1

            if state.thread is None or not state.thread.is_alive():
                thread = threading.Thread(
                    target=self._run, args=(key, state), name=f"prewarm-{doc.doc_id[:8]}", daemon=True
                )
                state.thread = thread
                thread.start()

    def status(self, doc: Document, voice: str) -> tuple[int, int]:
        """Return (ready, total) for the chunks this document currently targets."""
        targets = self._targets(doc, self._start_index(doc.doc_id, voice))
        ready = sum(1 for i in targets if is_cached(doc.doc_id, i, voice))
        return ready, len(targets)

    def _start_index(self, doc_id: str, voice: str) -> int:
        with self._lock:
            state = self._workers.get((doc_id, voice))
            return state.start_index if state else 0

    @staticmethod
    def _targets(doc: Document, start_index: int) -> list[int]:
        total = len(doc.chunks)
        start = max(0, min(start_index, max(0, total - 1)))
        if total <= settings.prewarm_full_max_chunks:
            # Whole document, starting from where the reader is and wrapping.
            return list(range(start, total)) + list(range(0, start))
        end = min(total, start + settings.prewarm_window_chunks)
        return list(range(start, end))

    @staticmethod
    def _await_quiet(state: WorkerState, revision: int) -> bool:
        """Hold off while the reader is actively requesting audio.

        Synthesis runs one at a time, so starting a background chunk just as a
        user request arrives would make them wait out its full duration.
        Returns False if the work became stale while waiting."""
        quiet = settings.prewarm_quiet_seconds
        while True:
            if state.cancelled:
                return False
            with state._lock:
                if state.revision != revision:
                    return False  # reader moved: this chunk may no longer matter
            idle = seconds_since_foreground()
            if idle >= quiet:
                return True
            time.sleep(min(quiet - idle, quiet))

    def _run(self, key: WorkerKey, state: WorkerState) -> None:
        while True:
            with state._lock:
                revision = state.revision
                start_index = state.start_index
            if state.cancelled:
                break

            targets = self._targets(state.doc, start_index)
            for index in targets:
                if state.cancelled:
                    break
                with state._lock:
                    if state.revision != revision:
                        break  # reader moved: recompute the target list
                if is_cached(state.doc.doc_id, index, state.voice):
                    continue
                if not self._await_quiet(state, revision):
                    break
                try:
                    get_or_synthesize(
                        state.doc.doc_id,
                        index,
                        state.doc.chunks[index],
                        state.voice,
                        foreground=False,
                    )
                except Exception:
                    logger.exception("prewarm failed for chunk %s", index)
                    # Keep going: one bad chunk shouldn't stop the whole document.

            with state._lock:
                finished = state.revision == revision
            if finished or state.cancelled:
                break

        with self._lock:
            current = self._workers.get(key)
            if current is state:
                state.thread = None


prewarm = PrewarmManager()
