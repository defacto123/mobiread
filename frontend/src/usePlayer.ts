import { useCallback, useEffect, useRef, useState } from "react";

import { fetchChunk } from "./api";
import type { LoadedChunk } from "./types";

/** A tiny silent WAV used to "unlock" the audio element on the first user
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

/** Resolve once an element's metadata (duration/seekable) is ready. */
function waitForMetadata(el: HTMLAudioElement): Promise<void> {
  return new Promise<void>((resolve) => {
    if (el.readyState >= 1 /* HAVE_METADATA */) {
      resolve();
      return;
    }
    const onReady = () => {
      el.removeEventListener("loadedmetadata", onReady);
      resolve();
    };
    el.addEventListener("loadedmetadata", onReady);
    el.load();
  });
}

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
 * - Mobile reliability: a *single* audio element is unlocked on the first user
 *   gesture and reused for every chunk/voice. Mobile browsers (notably iOS)
 *   only reliably unlock the element touched during a gesture, so using one
 *   element avoids the "button shows Pause but audio is silent" failure mode.
 * - Near-seamless transitions: the upcoming chunk's audio is prefetched into an
 *   in-memory cache, so advancing only pays a tiny element reload (~100ms).
 * - Seamless voice switching: the current chunk keeps playing in the old voice
 *   while the new voice is synthesized in the background, then swaps in at the
 *   same position on the same (already unlocked) element.
 * - Race-proof: a generation token discards stale loads, and interrupted
 *   play() promises are treated as non-fatal so controls never get stuck.
 */
export function usePlayer(docId: string | null, numChunks: number, voice?: string) {
  const [state, setState] = useState<PlayerState>(INITIAL);

  const audioRef = useRef<HTMLAudioElement | null>(null);
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
  const prevVoiceRef = useRef<string | undefined>(voice);
  docIdRef.current = docId;
  numChunksRef.current = numChunks;

  const advanceRef = useRef<() => void>(() => {});
  const preloadNextRef = useRef<() => void>(() => {});

  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const a = new Audio();
      a.preload = "auto";
      a.addEventListener("ended", () => advanceRef.current());
      audioRef.current = a;
    }
    return audioRef.current;
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

  // Prefetch the next chunk's audio into the in-memory cache so advancing is
  // fast (no synthesis wait at the paragraph boundary).
  const preloadNext = useCallback(() => {
    const nextIdx = currentChunkRef.current + 1;
    if (nextIdx >= numChunksRef.current) return;
    if (cacheRef.current.has(nextIdx)) return;
    void fetchData(nextIdx).catch(() => {
      /* best-effort */
    });
  }, [fetchData]);
  preloadNextRef.current = preloadNext;

  // Start (or jump to) a chunk on the single audio element. Used for initial
  // play, auto-advance, explicit navigation, and word jumps.
  const goToChunk = useCallback(
    async (index: number, seekTime = 0, autoplay = true) => {
      if (!docIdRef.current || index < 0 || index >= numChunksRef.current) return;
      const gen = ++genRef.current;
      const el = ensureAudio();
      const cached = cacheRef.current.has(index);
      if (!cached) setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const data = await fetchData(index);
        if (!data || gen !== genRef.current) {
          if (!cached) setState((s) => ({ ...s, loading: false }));
          return;
        }
        el.src = data.audioUrl;
        el.playbackRate = rateRef.current;
        await waitForMetadata(el);
        if (gen !== genRef.current) return;

        try {
          el.currentTime = Math.min(seekTime, Math.max(0, data.duration - 0.05));
        } catch {
          /* not yet seekable; play() still starts from 0 */
        }
        currentChunkRef.current = index;
        lastWordRef.current = -1;
        setState((s) => ({
          ...s,
          currentChunk: index,
          duration: data.duration,
          currentTime: el.currentTime || 0,
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
    [ensureAudio, fetchData],
  );

  // Auto-advance to the next chunk when the current one ends.
  const advance = useCallback(async () => {
    const nextIdx = currentChunkRef.current + 1;
    if (nextIdx >= numChunksRef.current) {
      isPlayingRef.current = false;
      setState((s) => ({ ...s, isPlaying: false, activeWord: -1 }));
      return;
    }
    await goToChunk(nextIdx, 0, true);
  }, [goToChunk]);
  advanceRef.current = () => {
    void advance();
  };

  // Reset when a new document is loaded.
  useEffect(() => {
    genRef.current++;
    cacheRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));
    cacheRef.current = new Map();
    currentChunkRef.current = 0;
    isPlayingRef.current = false;
    lastWordRef.current = -1;
    voiceRef.current = voice;
    prevVoiceRef.current = voice; // don't trigger a voice swap on doc load
    setState({ ...INITIAL });
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Unlock the audio element on the first user gesture (mobile/iOS autoplay).
  const unlockedRef = useRef(false);
  useEffect(() => {
    const unlock = () => {
      if (unlockedRef.current) return;
      unlockedRef.current = true;
      const a = ensureAudio();
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
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchend", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("touchend", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchend", unlock);
    };
  }, [ensureAudio]);

  // Karaoke word-tracking loop (reads the element + current chunk words).
  const tick = useCallback(() => {
    const el = audioRef.current;
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

  // Seamless voice switch: keep the current chunk playing in the old voice while
  // the new voice is synthesized in the background, then swap it in at the same
  // position on the same (already unlocked) element. Upcoming chunks are
  // re-buffered in the new voice.
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
        // Bypass cache: we explicitly need the new voice. The old voice keeps
        // playing on the element while this synthesizes.
        data = await fetchChunk(docIdRef.current as string, curIdx, voice);
      } catch {
        setState((s) => ({ ...s, voiceLoading: false }));
        return;
      }
      if (gen !== genRef.current) {
        URL.revokeObjectURL(data.audioUrl);
        return;
      }
      const el = ensureAudio();
      // Capture where the old voice has reached *now* for continuity.
      const at = Math.min(el.currentTime || 0, Math.max(0, data.duration - 0.05));
      el.src = data.audioUrl;
      el.playbackRate = rateRef.current;
      await waitForMetadata(el);
      if (gen !== genRef.current) {
        URL.revokeObjectURL(data.audioUrl);
        return;
      }
      try {
        el.currentTime = at;
      } catch {
        /* ignore */
      }
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
      if (wasPlaying) {
        try {
          await el.play();
          isPlayingRef.current = true;
        } catch {
          /* non-fatal */
        }
      }
      preloadNextRef.current();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, docId]);

  const play = useCallback(async () => {
    const el = ensureAudio();
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
  }, [ensureAudio, goToChunk]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    isPlayingRef.current = false;
    setState((s) => ({ ...s, isPlaying: false }));
  }, []);

  const toggle = useCallback(() => {
    if (isPlayingRef.current) pause();
    else void play();
  }, [play, pause]);

  const seek = useCallback((time: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(time, el.duration || time));
    setState((s) => ({ ...s, currentTime: el.currentTime }));
  }, []);

  const skip = useCallback(
    (delta: number) => {
      const el = audioRef.current;
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
    if (audioRef.current) audioRef.current.playbackRate = rate;
    setState((s) => ({ ...s, rate }));
  }, []);

  const jumpToWord = useCallback(
    async (chunkIndex: number, wordIndex: number) => {
      const chunk = await fetchData(chunkIndex);
      const start = chunk?.words[wordIndex]?.start ?? 0;
      if (chunkIndex === currentChunkRef.current && audioRef.current?.src) {
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
