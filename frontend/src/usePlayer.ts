import { useCallback, useEffect, useRef, useState } from "react";

import { fetchChunk } from "./api";
import type { LoadedChunk } from "./types";

interface PlayerState {
  currentChunk: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  activeWord: number;
  loading: boolean;
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
  error: null,
};

/**
 * Drives sequential, chunk-by-chunk playback of a document.
 *
 * Responsibilities:
 * - lazy-load + cache each chunk's audio (with word timings)
 * - prefetch the next chunk while the current one plays
 * - auto-advance across chunks on end
 * - expose play/pause/seek/skip/rate + karaoke word tracking
 */
export function usePlayer(docId: string | null, numChunks: number, voice?: string) {
  const [state, setState] = useState<PlayerState>(INITIAL);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cacheRef = useRef<Map<number, LoadedChunk>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastWordRef = useRef<number>(-1);
  const lastTimePushRef = useRef<number>(0);

  // Reset everything when a new document is loaded.
  useEffect(() => {
    cacheRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));
    cacheRef.current = new Map();
    lastWordRef.current = -1;
    setState({ ...INITIAL });
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
    }
  }, [docId]);

  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    return audioRef.current;
  }, []);

  const loadChunk = useCallback(
    async (index: number): Promise<LoadedChunk | null> => {
      if (!docId || index < 0 || index >= numChunks) return null;
      const cached = cacheRef.current.get(index);
      if (cached) return cached;
      const loaded = await fetchChunk(docId, index, voice);
      cacheRef.current.set(index, loaded);
      return loaded;
    },
    [docId, numChunks, voice],
  );

  const prefetchNext = useCallback(
    (index: number) => {
      const next = index + 1;
      if (next < numChunks && !cacheRef.current.has(next)) {
        loadChunk(next).catch(() => {
          /* prefetch is best-effort */
        });
      }
    },
    [loadChunk, numChunks],
  );

  // Karaoke tracking loop while playing.
  const tick = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = audio.currentTime;
    const words = cacheRef.current.get(state.currentChunk)?.words ?? [];

    let active = lastWordRef.current;
    if (active < 0 || active >= words.length || t < words[active].start || t >= words[active].end) {
      active = words.findIndex((w) => t >= w.start && t < w.end);
      if (active === -1) {
        // Between words: keep last if before next, else the last passed word.
        active = words.reduce((acc, w, i) => (t >= w.start ? i : acc), -1);
      }
    }

    const now = performance.now();
    setState((s) => {
      const next = { ...s };
      let changed = false;
      if (active !== lastWordRef.current) {
        next.activeWord = active;
        lastWordRef.current = active;
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
  }, [state.currentChunk]);

  const startLoop = useCallback(() => {
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [tick]);

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Restart the loop when the tick callback identity changes (chunk switch).
  useEffect(() => {
    if (state.isPlaying) {
      stopLoop();
      startLoop();
    }
    return stopLoop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isPlaying, tick]);

  const goToChunk = useCallback(
    async (index: number, seekTime = 0, autoplay = true) => {
      if (!docId || index < 0 || index >= numChunks) return;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const chunk = await loadChunk(index);
        if (!chunk) return;
        const audio = ensureAudio();
        audio.src = chunk.audioUrl;
        audio.playbackRate = state.rate;
        lastWordRef.current = -1;

        await new Promise<void>((resolve) => {
          const onReady = () => {
            audio.removeEventListener("loadedmetadata", onReady);
            resolve();
          };
          audio.addEventListener("loadedmetadata", onReady);
          audio.load();
        });

        audio.currentTime = Math.min(seekTime, Math.max(0, chunk.duration - 0.05));
        setState((s) => ({
          ...s,
          currentChunk: index,
          duration: chunk.duration,
          currentTime: audio.currentTime,
          activeWord: -1,
          loading: false,
        }));
        prefetchNext(index);
        if (autoplay) {
          await audio.play();
          setState((s) => ({ ...s, isPlaying: true }));
        }
      } catch (err) {
        setState((s) => ({
          ...s,
          loading: false,
          isPlaying: false,
          error: err instanceof Error ? err.message : "Playback failed",
        }));
      }
    },
    [docId, numChunks, loadChunk, ensureAudio, prefetchNext, state.rate],
  );

  // Wire the audio "ended" handler to auto-advance.
  useEffect(() => {
    const audio = ensureAudio();
    const onEnded = () => {
      const next = state.currentChunk + 1;
      if (next < numChunks) {
        goToChunk(next, 0, true);
      } else {
        setState((s) => ({ ...s, isPlaying: false, activeWord: -1 }));
      }
    };
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, [ensureAudio, state.currentChunk, numChunks, goToChunk]);

  const play = useCallback(async () => {
    const audio = ensureAudio();
    if (!audio.src) {
      await goToChunk(state.currentChunk, 0, true);
      return;
    }
    await audio.play();
    setState((s) => ({ ...s, isPlaying: true }));
  }, [ensureAudio, goToChunk, state.currentChunk]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setState((s) => ({ ...s, isPlaying: false }));
  }, []);

  const toggle = useCallback(() => {
    if (state.isPlaying) pause();
    else void play();
  }, [state.isPlaying, play, pause]);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(time, audio.duration || time));
    setState((s) => ({ ...s, currentTime: audio.currentTime }));
  }, []);

  const skip = useCallback(
    (delta: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const target = audio.currentTime + delta;
      if (target < 0 && state.currentChunk > 0) {
        void goToChunk(state.currentChunk - 1, 9999, state.isPlaying);
      } else if (target > (audio.duration || state.duration) && state.currentChunk < numChunks - 1) {
        void goToChunk(state.currentChunk + 1, 0, state.isPlaying);
      } else {
        seek(target);
      }
    },
    [goToChunk, seek, state.currentChunk, state.duration, state.isPlaying, numChunks],
  );

  const setRate = useCallback((rate: number) => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
    setState((s) => ({ ...s, rate }));
  }, []);

  const jumpToWord = useCallback(
    async (chunkIndex: number, wordIndex: number) => {
      const chunk = await loadChunk(chunkIndex);
      const start = chunk?.words[wordIndex]?.start ?? 0;
      if (chunkIndex === state.currentChunk && audioRef.current?.src) {
        seek(start);
        if (!state.isPlaying) void play();
      } else {
        void goToChunk(chunkIndex, start, true);
      }
    },
    [loadChunk, state.currentChunk, state.isPlaying, seek, play, goToChunk],
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
