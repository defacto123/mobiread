import { useCallback, useEffect, useRef, useState } from "react";

import { fetchChunk } from "./api";
import type { LoadedChunk } from "./types";

/** A tiny silent WAV used to "unlock" the audio elements on the first user
 * gesture so later programmatic playback works under mobile autoplay policies
 * (notably iOS Safari), even when a tap is followed by an async chunk fetch. */
function buildSilentWavDataUri(): string {
  const sampleRate = 8000;
  const numSamples = 800;
  const blockAlign = 2;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(binary);
}

const SILENT_WAV = buildSilentWavDataUri();

interface PlayerState {
  currentChunk: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  activeWord: number;
  loading: boolean;
  voiceLoading: boolean;
  error: string | null;
}

const INITIAL: PlayerState = {
  currentChunk: 0,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  rate: 1,
  activeWord: -1,
  loading: false,
  voiceLoading: false,
  error: null,
};

/**
 * Drives sequential, chunk-by-chunk playback of a document.
 *
 * Design goals:
 * - Gapless paragraph transitions: two audio elements ping-pong, so the next
 *   chunk is already buffered when the current one ends.
 * - Seamless voice switching: the current chunk keeps playing while the new
 *   voice is synthesized in the background, then swaps in at the same position
 *   (no silence, no waiting for the paragraph to end).
 * - Race-proof: a generation token discards stale loads, and interrupted
 *   play() promises are treated as non-fatal so controls never get stuck.
 */
export function usePlayer(docId: string | null, numChunks: number, voice?: string) {
  const [state, setState] = useState<PlayerState>(INITIAL);

  // Two audio elements; `activeIdx` is the one currently playing, the other is
  // used to pre-buffer the upcoming chunk.
  const audiosRef = useRef<HTMLAudioElement[]>([]);
  const activeIdxRef = useRef(0);
  const preloadIdxRef = useRef(-1); // chunk index buffered in the idle element

  const cacheRef = useRef<Map<number, LoadedChunk>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastWordRef = useRef(-1);
  const lastTimePushRef = useRef(0);
  const genRef = useRef(0);

  // Mirror props/state into refs so the long-lived audio event handlers and
  // async flows always read fresh values without stale closures.
  const currentChunkRef = useRef(0);
  const isPlayingRef = useRef(false);
  const rateRef = useRef(1);
  const docIdRef = useRef(docId);
  const numChunksRef = useRef(numChunks);
  const voiceRef = useRef(voice);
  docIdRef.current = docId;
  numChunksRef.current = numChunks;

  const advanceRef = useRef<() => void>(() => {});
  const preloadNextRef = useRef<() => void>(() => {});

  const idle = () => audiosRef.current[1 - activeIdxRef.current];
  const active = () => audiosRef.current[activeIdxRef.current];

  const ensureAudios = useCallback((): HTMLAudioElement[] => {
    if (audiosRef.current.length === 0) {
      const make = () => {
        const a = new Audio();
        a.preload = "auto";
        a.addEventListener("ended", (ev) => {
          // Only the element that is actually playing should auto-advance.
          if (ev.target === audiosRef.current[activeIdxRef.current]) advanceRef.current();
        });
        return a;
      };
      audiosRef.current = [make(), make()];
    }
    return audiosRef.current;
  }, []);

  // Cache-aware fetch using the *current* voice (read from ref).
  const fetchData = useCallback(async (index: number): Promise<LoadedChunk | null> => {
    if (!docIdRef.current || index < 0 || index >= numChunksRef.current) return null;
    const cached = cacheRef.current.get(index);
    if (cached) return cached;
    const loaded = await fetchChunk(docIdRef.current, index, voiceRef.current);
    cacheRef.current.set(index, loaded);
    return loaded;
  }, []);

  // Pre-buffer the next chunk into the idle audio element.
  const preloadNext = useCallback(() => {
    const nextIdx = currentChunkRef.current + 1;
    if (nextIdx >= numChunksRef.current) return;
    if (preloadIdxRef.current === nextIdx) return;
    void fetchData(nextIdx)
      .then((data) => {
        if (!data || currentChunkRef.current + 1 !== nextIdx) return;
        const el = idle();
        el.src = data.audioUrl;
        el.playbackRate = rateRef.current;
        el.load();
        preloadIdxRef.current = nextIdx;
      })
      .catch(() => {
        /* best-effort */
      });
  }, [fetchData]);
  preloadNextRef.current = preloadNext;

  // Auto-advance to the next chunk, using the pre-buffered element when ready
  // so the transition is gapless.
  const advance = useCallback(async () => {
    const nextIdx = currentChunkRef.current + 1;
    if (nextIdx >= numChunksRef.current) {
      isPlayingRef.current = false;
      setState((s) => ({ ...s, isPlaying: false, activeWord: -1 }));
      return;
    }

    // Natural progression takes ownership: invalidates any in-flight voice swap
    // or jump so they can't fight this transition.
    const gen = ++genRef.current;
    const incoming = idle();
    let data = cacheRef.current.get(nextIdx) ?? null;
    const alreadyBuffered = preloadIdxRef.current === nextIdx && !!incoming.src;
    if (!alreadyBuffered) {
      data = await fetchData(nextIdx);
      if (!data || gen !== genRef.current) return;
      incoming.src = data.audioUrl;
      incoming.playbackRate = rateRef.current;
      incoming.load();
    }
    if (!data) data = cacheRef.current.get(nextIdx) ?? null;
    if (!data || gen !== genRef.current) return;

    try {
      incoming.currentTime = 0;
    } catch {
      /* not yet seekable; play() still starts from 0 */
    }
    activeIdxRef.current = 1 - activeIdxRef.current;
    preloadIdxRef.current = -1;
    currentChunkRef.current = nextIdx;
    lastWordRef.current = -1;
    setState((s) => ({
      ...s,
      currentChunk: nextIdx,
      duration: data!.duration,
      currentTime: 0,
      activeWord: -1,
    }));
    try {
      await incoming.play();
      isPlayingRef.current = true;
    } catch {
      /* interrupted play() is non-fatal */
    }
    preloadNextRef.current();
  }, [fetchData]);
  advanceRef.current = () => {
    void advance();
  };

  // Reset when a new document is loaded.
  useEffect(() => {
    genRef.current++;
    cacheRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));
    cacheRef.current = new Map();
    preloadIdxRef.current = -1;
    currentChunkRef.current = 0;
    isPlayingRef.current = false;
    lastWordRef.current = -1;
    voiceRef.current = voice;
    setState({ ...INITIAL });
    audiosRef.current.forEach((a) => {
      a.pause();
      a.removeAttribute("src");
    });
    activeIdxRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Unlock both audio elements on the first user gesture (mobile/iOS autoplay).
  const unlockedRef = useRef(false);
  useEffect(() => {
    const unlock = () => {
      if (unlockedRef.current) return;
      unlockedRef.current = true;
      ensureAudios().forEach((a) => {
        try {
          a.src = SILENT_WAV;
          const p = a.play();
          if (p && typeof p.then === "function") {
            p.then(() => {
              a.pause();
              a.currentTime = 0;
              a.removeAttribute("src");
            }).catch(() => {
              /* still primed for later playback */
            });
          }
        } catch {
          /* ignore */
        }
      });
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchend", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("touchend", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchend", unlock);
    };
  }, [ensureAudios]);

  // Karaoke word-tracking loop (reads the active element + current chunk words).
  const tick = useCallback(() => {
    const el = audiosRef.current[activeIdxRef.current];
    if (!el) return;
    const t = el.currentTime;
    const words = cacheRef.current.get(currentChunkRef.current)?.words ?? [];

    let act = lastWordRef.current;
    if (act < 0 || act >= words.length || t < words[act].start || t >= words[act].end) {
      act = words.findIndex((w) => t >= w.start && t < w.end);
      if (act === -1) act = words.reduce((acc, w, i) => (t >= w.start ? i : acc), -1);
    }

    const now = performance.now();
    setState((s) => {
      const next = { ...s };
      let changed = false;
      if (act !== lastWordRef.current) {
        next.activeWord = act;
        lastWordRef.current = act;
        changed = true;
      }
      if (now - lastTimePushRef.current > 80) {
        next.currentTime = t;
        lastTimePushRef.current = now;
        changed = true;
      }
      return changed ? next : s;
    });

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    if (state.isPlaying) {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
    }
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [state.isPlaying, tick]);

  // Start (or jump to) a chunk on the active element. Used for initial play,
  // explicit chunk navigation, and word jumps. Interrupts current playback.
  const goToChunk = useCallback(
    async (index: number, seekTime = 0, autoplay = true) => {
      if (!docIdRef.current || index < 0 || index >= numChunksRef.current) return;
      const gen = ++genRef.current;
      ensureAudios();
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const data = await fetchData(index);
        if (!data || gen !== genRef.current) {
          setState((s) => ({ ...s, loading: false }));
          return;
        }
        const el = active();
        el.src = data.audioUrl;
        el.playbackRate = rateRef.current;
        await new Promise<void>((resolve) => {
          const onReady = () => {
            el.removeEventListener("loadedmetadata", onReady);
            resolve();
          };
          el.addEventListener("loadedmetadata", onReady);
          el.load();
        });
        if (gen !== genRef.current) return;

        el.currentTime = Math.min(seekTime, Math.max(0, data.duration - 0.05));
        preloadIdxRef.current = -1;
        currentChunkRef.current = index;
        lastWordRef.current = -1;
        setState((s) => ({
          ...s,
          currentChunk: index,
          duration: data.duration,
          currentTime: el.currentTime,
          activeWord: -1,
          loading: false,
        }));
        if (autoplay) {
          try {
            await el.play();
            isPlayingRef.current = true;
            setState((s) => ({ ...s, isPlaying: true }));
          } catch {
            /* interrupted play() is non-fatal */
          }
        }
        preloadNextRef.current();
      } catch (err) {
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : "Playback failed",
        }));
      }
    },
    [ensureAudios, fetchData],
  );

  // Seamless voice switch: keep the current chunk playing in the old voice while
  // the new voice is synthesized, then swap in at the same position. Upcoming
  // chunks are re-buffered in the new voice.
  const prevVoiceRef = useRef<string | undefined>(voice);
  useEffect(() => {
    if (prevVoiceRef.current === voice) return;
    prevVoiceRef.current = voice;
    voiceRef.current = voice;
    if (!docIdRef.current) return;

    const gen = ++genRef.current;
    const curIdx = currentChunkRef.current;
    const wasPlaying = isPlayingRef.current;
    setState((s) => ({ ...s, voiceLoading: true }));

    (async () => {
      let data: LoadedChunk;
      try {
        data = await fetchChunk(docIdRef.current as string, curIdx, voice);
      } catch {
        setState((s) => ({ ...s, voiceLoading: false }));
        return;
      }
      if (gen !== genRef.current) {
        URL.revokeObjectURL(data.audioUrl);
        return;
      }
      const incoming = idle();
      incoming.src = data.audioUrl;
      incoming.playbackRate = rateRef.current;
      await new Promise<void>((resolve) => {
        const onReady = () => {
          incoming.removeEventListener("loadedmetadata", onReady);
          resolve();
        };
        incoming.addEventListener("loadedmetadata", onReady);
        incoming.load();
      });
      if (gen !== genRef.current) {
        URL.revokeObjectURL(data.audioUrl);
        return;
      }

      // Resume from where the old voice has reached *now* for continuity.
      const old = active();
      const at = Math.min(old.currentTime || 0, Math.max(0, data.duration - 0.05));
      try {
        incoming.currentTime = at;
      } catch {
        /* ignore */
      }
      if (wasPlaying) {
        try {
          await incoming.play();
          isPlayingRef.current = true;
        } catch {
          /* non-fatal */
        }
      }
      old.pause();
      activeIdxRef.current = 1 - activeIdxRef.current;
      preloadIdxRef.current = -1;
      lastWordRef.current = -1;

      // Drop old-voice cache, keep the freshly synthesized current chunk.
      cacheRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));
      cacheRef.current = new Map();
      cacheRef.current.set(curIdx, data);

      setState((s) => ({
        ...s,
        duration: data.duration,
        currentTime: at,
        activeWord: -1,
        voiceLoading: false,
      }));
      preloadNextRef.current();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, docId]);

  const play = useCallback(async () => {
    ensureAudios();
    const el = active();
    if (!el.src || el.src === SILENT_WAV) {
      await goToChunk(currentChunkRef.current, 0, true);
      return;
    }
    try {
      await el.play();
      isPlayingRef.current = true;
      setState((s) => ({ ...s, isPlaying: true }));
    } catch {
      /* non-fatal */
    }
  }, [ensureAudios, goToChunk]);

  const pause = useCallback(() => {
    active()?.pause();
    isPlayingRef.current = false;
    setState((s) => ({ ...s, isPlaying: false }));
  }, []);

  const toggle = useCallback(() => {
    if (isPlayingRef.current) pause();
    else void play();
  }, [play, pause]);

  const seek = useCallback((time: number) => {
    const el = active();
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(time, el.duration || time));
    setState((s) => ({ ...s, currentTime: el.currentTime }));
  }, []);

  const skip = useCallback(
    (delta: number) => {
      const el = active();
      if (!el) return;
      const target = el.currentTime + delta;
      const dur = el.duration || state.duration;
      if (target < 0 && currentChunkRef.current > 0) {
        void goToChunk(currentChunkRef.current - 1, 9999, isPlayingRef.current);
      } else if (target > dur && currentChunkRef.current < numChunksRef.current - 1) {
        void goToChunk(currentChunkRef.current + 1, 0, isPlayingRef.current);
      } else {
        seek(target);
      }
    },
    [goToChunk, seek, state.duration],
  );

  const setRate = useCallback((rate: number) => {
    rateRef.current = rate;
    audiosRef.current.forEach((a) => {
      a.playbackRate = rate;
    });
    setState((s) => ({ ...s, rate }));
  }, []);

  const jumpToWord = useCallback(
    async (chunkIndex: number, wordIndex: number) => {
      const chunk = await fetchData(chunkIndex);
      const start = chunk?.words[wordIndex]?.start ?? 0;
      if (chunkIndex === currentChunkRef.current && active()?.src) {
        seek(start);
        if (!isPlayingRef.current) void play();
      } else {
        void goToChunk(chunkIndex, start, true);
      }
    },
    [fetchData, seek, play, goToChunk],
  );

  return {
    ...state,
    play,
    pause,
    toggle,
    seek,
    skip,
    setRate,
    goToChunk,
    jumpToWord,
  };
}
