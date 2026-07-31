import { useCallback, useEffect, useRef, useState } from "react";
import { PitchShifter } from "soundtouchjs";

import { fetchChunk, warmDoc } from "./api";
import type { LoadedChunk, WordTiming } from "./types";

/** How many chunks ahead of the reader to download. The backend pre-generates a
 * wider range; this is just the local copy so playback never waits on network.
 * Kept small: each chunk is ~1 MB, and a burst of parallel requests pushes
 * Cloud Run to add instances, which defeats the server-side cache. */
const PREFETCH_AHEAD = 3;
/** Max simultaneous prefetch downloads. One, so a user-initiated request is
 * never stuck behind them in the browser's per-host connection pool. */
const MAX_PARALLEL_PREFETCH = 1;
/** Caps on client memory: encoded audio bytes, and decoded (much larger) PCM. */
const MAX_CACHE_BYTES = 120 * 1024 * 1024;
const MAX_DECODED_CHUNKS = 12;

/** Decode encoded audio bytes into a PCM AudioBuffer. Supports both the
 * promise-based and legacy callback-based decodeAudioData signatures (older
 * Safari only had the callback form). */
function decodeAudioData(ctx: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    const ret = ctx.decodeAudioData(bytes, resolve, reject);
    if (ret && typeof (ret as Promise<AudioBuffer>).then === "function") {
      (ret as Promise<AudioBuffer>).then(resolve, reject);
    }
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
 * Drives sequential, chunk-by-chunk playback of a document using the Web Audio
 * API. Each chunk is played through a SoundTouch `PitchShifter` node.
 *
 * Why this design:
 * - Mobile reliability: the AudioContext is unlocked once on the first user
 *   gesture; after that, *any* buffer can be played at *any* time with no
 *   per-clip re-unlock. This cures the recurring mobile failure where
 *   auto-advance/voice-swap silently stopped while the button still said Pause.
 * - Pitch-preserving speed: PitchShifter changes tempo without changing pitch,
 *   so faster/slower playback keeps the voice's natural pitch (no chipmunk).
 * - Instant actions: seeking, word-jumps and voice changes stop the current
 *   node and start a new one at the exact offset immediately.
 *
 * Position is reported by the PitchShifter `play` event (in source seconds, so
 * it's tempo-independent); karaoke + progress read from it. A generation token
 * discards stale async work.
 */
export function usePlayer(docId: string | null, chunks: string[], voice?: string) {
  const [state, setState] = useState<PlayerState>(INITIAL);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const shifterRef = useRef<PitchShifter | null>(null);
  // Keyed by `voice::index` so audio synthesized in one voice is never reused
  // after the voice changes.
  const cacheRef = useRef<Map<string, LoadedChunk>>(new Map());
  // Word timings of the chunk that is currently loaded/playing (decoupled from
  // the cache so the karaoke loop doesn't depend on cache keying).
  const currentWordsRef = useRef<WordTiming[]>([]);

  const rafRef = useRef<number | null>(null);
  const lastWordRef = useRef(-1);
  const lastTimePushRef = useRef(0);
  const genRef = useRef(0);

  // Position bookkeeping.
  const playedRef = useRef(0); // current source position (s), updated by PitchShifter
  const pauseOffsetRef = useRef(0); // media offset (s) to resume from when paused
  const durationRef = useRef(0); // current chunk duration (s)

  // In-flight fetches deduped by `voice::index` so repeated clicks on the same
  // chunk reuse one synthesis request (and cache it) instead of restarting it.
  const inflightRef = useRef<Map<string, Promise<LoadedChunk>>>(new Map());
  // Abort handles for in-flight requests, and which of them are mere prefetches
  // (safe to cancel the moment the user asks for something specific).
  const abortersRef = useRef<Map<string, AbortController>>(new Map());
  const prefetchKeysRef = useRef<Set<string>>(new Set());
  // Timer-based end-of-chunk detection (reliable even when the audio node stops
  // emitting progress events near the end).
  const endTimerRef = useRef<number | null>(null);
  const rescheduleEndRef = useRef<(() => void) | null>(null);

  // Mirror props/state into refs so long-lived callbacks read fresh values.
  const currentChunkRef = useRef(0);
  const isPlayingRef = useRef(false);
  const rateRef = useRef(1);
  const docIdRef = useRef(docId);
  const numChunksRef = useRef(chunks.length);
  // The chunk texts are sent with each request so any backend instance can
  // serve it, even one that never received this document's upload.
  const chunksRef = useRef(chunks);
  const voiceRef = useRef(voice);
  const prevVoiceRef = useRef<string | undefined>(voice);
  docIdRef.current = docId;
  numChunksRef.current = chunks.length;
  chunksRef.current = chunks;

  const advanceRef = useRef<() => void>(() => {});
  const preloadNextRef = useRef<() => void>(() => {});

  const getCtx = (): AudioContext => {
    if (!audioCtxRef.current) {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new Ctor();
    }
    return audioCtxRef.current;
  };

  const clearEndTimer = () => {
    if (endTimerRef.current != null) {
      clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
    }
    rescheduleEndRef.current = null;
  };

  // Stop + tear down the current PitchShifter node (disconnect halts output).
  const stopCurrentSource = () => {
    clearEndTimer();
    const sh = shifterRef.current;
    shifterRef.current = null;
    if (sh) {
      try {
        sh.disconnect();
      } catch {
        /* ignore */
      }
    }
  };

  const currentMediaTime = (): number => {
    if (isPlayingRef.current && shifterRef.current) {
      return Math.min(Math.max(0, playedRef.current), durationRef.current || playedRef.current);
    }
    return pauseOffsetRef.current;
  };

  // Create a PitchShifter for `buffer`, seek to `offset`, and start playing.
  const startSource = (buffer: AudioBuffer, offset: number, gen: number) => {
    const ctx = getCtx();
    const dur = buffer.duration || 0.0001;
    const startAt = Math.min(Math.max(0, offset), Math.max(0, dur - 0.02));
    const shifter = new PitchShifter(ctx, buffer, 4096);
    shifter.tempo = rateRef.current; // speed without pitch change
    shifter.percentagePlayed = startAt / dur; // setter takes a 0..1 fraction
    playedRef.current = startAt;

    let ended = false;
    const fireEnd = () => {
      if (ended || gen !== genRef.current || shifterRef.current !== shifter) return;
      ended = true;
      stopCurrentSource();
      advanceRef.current();
    };

    // The PitchShifter `play` event drives the karaoke position. It can stop
    // firing once the source is exhausted, so end-of-chunk is handled by a
    // wall-clock timer instead (robust regardless of events).
    shifter.on("play", (detail) => {
      if (gen !== genRef.current || shifterRef.current !== shifter) return;
      playedRef.current = detail.timePlayed;
    });

    // Schedule auto-advance based on the *remaining* media time and current
    // tempo. Re-scheduled when the speed changes mid-playback.
    const scheduleEnd = () => {
      if (endTimerRef.current != null) clearTimeout(endTimerRef.current);
      const remaining = Math.max(0, dur - playedRef.current);
      const ms = (remaining / Math.max(0.1, rateRef.current)) * 1000 + 150;
      endTimerRef.current = window.setTimeout(fireEnd, ms);
    };
    rescheduleEndRef.current = scheduleEnd;

    shifterRef.current = shifter;
    shifter.connect(ctx.destination);
    scheduleEnd();
  };

  const decode = async (data: LoadedChunk): Promise<AudioBuffer | null> => {
    if (data.audioBuffer) return data.audioBuffer;
    const ctx = getCtx();
    try {
      // slice() because decodeAudioData detaches the ArrayBuffer it consumes.
      const buf = await decodeAudioData(ctx, data.bytes.slice(0));
      data.audioBuffer = buf;
      return buf;
    } catch {
      return null;
    }
  };

  const cacheKey = (voice: string | undefined, index: number) => `${voice ?? ""}::${index}`;

  // Keep client memory bounded: evict least-recently-used encoded audio beyond
  // the byte cap, and drop decoded PCM (roughly 2x the encoded size) beyond a
  // small window. Bytes are kept longer than decoded buffers because re-decoding
  // is cheap while re-downloading is not.
  const enforceCacheLimits = () => {
    const cache = cacheRef.current;
    const keep = cacheKey(voiceRef.current, currentChunkRef.current);

    let decoded = 0;
    for (const [key, entry] of [...cache.entries()].reverse()) {
      if (!entry.audioBuffer) continue;
      decoded += 1;
      if (decoded > MAX_DECODED_CHUNKS && key !== keep) entry.audioBuffer = null;
    }

    let total = 0;
    for (const entry of cache.values()) total += entry.bytes.byteLength;
    for (const key of [...cache.keys()]) {
      if (total <= MAX_CACHE_BYTES) break;
      if (key === keep || inflightRef.current.has(key)) continue;
      const entry = cache.get(key);
      if (!entry) continue;
      total -= entry.bytes.byteLength;
      cache.delete(key);
    }
  };

  // Cancel background downloads so a user-initiated request gets the network
  // (and the backend's synthesis slot) to itself. Prefetched work already
  // completed on the server stays cached there, so nothing is wasted.
  const cancelPrefetches = () => {
    for (const key of [...prefetchKeysRef.current]) {
      abortersRef.current.get(key)?.abort();
      abortersRef.current.delete(key);
      inflightRef.current.delete(key);
      prefetchKeysRef.current.delete(key);
    }
  };

  // Cache-aware fetch using the *current* voice. The voice is captured at call
  // time and baked into the cache key, so entries from a previous voice are
  // never returned after the voice changes.
  const fetchData = async (
    index: number,
    prefetch = false,
  ): Promise<LoadedChunk | null> => {
    if (!docIdRef.current || index < 0 || index >= numChunksRef.current) return null;
    const v = voiceRef.current;
    const key = cacheKey(v, index);
    const cached = cacheRef.current.get(key);
    if (cached) {
      cacheRef.current.delete(key); // re-insert to mark most-recently-used
      cacheRef.current.set(key, cached);
      return cached;
    }
    // Reuse an in-flight request for the same chunk/voice so rapid repeated
    // clicks don't each kick off (and then cancel) a fresh synthesis.
    const inflight = inflightRef.current.get(key);
    if (inflight) {
      // A prefetch that the user is now actually waiting for must survive the
      // next cancelPrefetches() call.
      if (!prefetch) prefetchKeysRef.current.delete(key);
      return inflight;
    }

    const docId = docIdRef.current;
    const controller = new AbortController();
    abortersRef.current.set(key, controller);
    if (prefetch) prefetchKeysRef.current.add(key);

    const p = fetchChunk(docId, index, v, controller.signal, chunksRef.current[index])
      .then((loaded) => {
        cacheRef.current.set(key, loaded);
        inflightRef.current.delete(key);
        abortersRef.current.delete(key);
        prefetchKeysRef.current.delete(key);
        enforceCacheLimits();
        return loaded;
      })
      .catch((err) => {
        inflightRef.current.delete(key);
        abortersRef.current.delete(key);
        prefetchKeysRef.current.delete(key);
        throw err;
      });
    inflightRef.current.set(key, p);
    return p;
  };

  // Keep a rolling window of upcoming chunks downloaded so auto-advance never
  // waits, refilling as each prefetch completes.
  const preloadNext = () => {
    const start = currentChunkRef.current + 1;
    const end = Math.min(numChunksRef.current, start + PREFETCH_AHEAD);
    for (let idx = start; idx < end; idx++) {
      if (prefetchKeysRef.current.size >= MAX_PARALLEL_PREFETCH) return;
      const key = cacheKey(voiceRef.current, idx);
      if (cacheRef.current.has(key) || inflightRef.current.has(key)) continue;
      void fetchData(idx, true)
        .then((d) => (d ? decode(d) : null))
        .then(() => preloadNextRef.current())
        .catch(() => {
          /* best-effort */
        });
    }
  };
  preloadNextRef.current = preloadNext;

  // Point the backend's background pre-generation at the reader's position.
  const requestWarm = (index: number) => {
    if (!docIdRef.current) return;
    void warmDoc(docIdRef.current, voiceRef.current, index, chunksRef.current);
  };

  // Load + (optionally) play a chunk from a given offset. Stops any current
  // source immediately so explicit navigation/auto-advance take effect at once.
  // When `wordIndex` is given, playback starts at that word's timed offset
  // (resolved after the chunk's audio + timings are loaded).
  const playChunk = async (
    index: number,
    offset = 0,
    autoplay = true,
    wordIndex?: number,
  ): Promise<void> => {
    if (!docIdRef.current || index < 0 || index >= numChunksRef.current) return;
    const gen = ++genRef.current;
    stopCurrentSource();
    // Free the network + the backend's synthesis slot for this request.
    cancelPrefetches();
    requestWarm(index);
    const ctx = getCtx();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    const cached = cacheRef.current.has(cacheKey(voiceRef.current, index));
    if (!cached) setState((s) => ({ ...s, loading: true, error: null }));

    let data: LoadedChunk | null;
    try {
      data = await fetchData(index);
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : "Playback failed",
      }));
      return;
    }
    if (!data || gen !== genRef.current) {
      if (!cached) setState((s) => ({ ...s, loading: false }));
      return;
    }

    const buffer = await decode(data);
    if (!buffer || gen !== genRef.current) {
      setState((s) => ({
        ...s,
        loading: false,
        error: buffer ? s.error : "Could not decode audio",
      }));
      return;
    }

    const desiredOffset =
      wordIndex != null && data.words[wordIndex] ? data.words[wordIndex].start : offset;
    const startAt = Math.min(Math.max(0, desiredOffset), Math.max(0, buffer.duration - 0.02));
    currentChunkRef.current = index;
    currentWordsRef.current = data.words;
    durationRef.current = buffer.duration;
    pauseOffsetRef.current = startAt;
    playedRef.current = startAt;
    lastWordRef.current = -1;
    setState((s) => ({
      ...s,
      currentChunk: index,
      duration: buffer.duration,
      currentTime: startAt,
      activeWord: -1,
      loading: false,
    }));

    if (autoplay) {
      startSource(buffer, startAt, gen);
      isPlayingRef.current = true;
      setState((s) => ({ ...s, isPlaying: true }));
    } else {
      isPlayingRef.current = false;
      setState((s) => ({ ...s, isPlaying: false }));
    }
    preloadNextRef.current();
  };

  const advance = async () => {
    const nextIdx = currentChunkRef.current + 1;
    if (nextIdx >= numChunksRef.current) {
      isPlayingRef.current = false;
      pauseOffsetRef.current = durationRef.current;
      setState((s) => ({ ...s, isPlaying: false, activeWord: -1 }));
      return;
    }
    await playChunk(nextIdx, 0, true);
  };
  advanceRef.current = () => {
    void advance();
  };

  // Reset when a new document is loaded.
  useEffect(() => {
    genRef.current++;
    stopCurrentSource();
    for (const controller of abortersRef.current.values()) controller.abort();
    abortersRef.current = new Map();
    prefetchKeysRef.current = new Set();
    cacheRef.current = new Map();
    inflightRef.current = new Map();
    currentWordsRef.current = [];
    currentChunkRef.current = 0;
    isPlayingRef.current = false;
    pauseOffsetRef.current = 0;
    playedRef.current = 0;
    durationRef.current = 0;
    lastWordRef.current = -1;
    voiceRef.current = voice;
    prevVoiceRef.current = voice; // don't trigger a voice swap on doc load
    setState({ ...INITIAL });
    // Start generating the document server-side right away, so playback and
    // seeking are ready before the user asks for them.
    if (docId) requestWarm(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Unlock/resume the AudioContext on the first user gesture (autoplay policy,
  // desktop and mobile). Creating the context *inside* the gesture is most
  // reliable on iOS, so we defer creation until here.
  useEffect(() => {
    const unlock = () => {
      const ctx = getCtx();
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      try {
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Karaoke word-tracking loop (reads the playback position + current words).
  const tick = useCallback(() => {
    const t = currentMediaTime();
    const words = currentWordsRef.current;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // the new voice is synthesized, then swap it in at the same position.
  // Upcoming chunks are re-buffered in the new voice (voice-aware cache).
  useEffect(() => {
    if (prevVoiceRef.current === voice) return;
    prevVoiceRef.current = voice;
    voiceRef.current = voice;
    if (!docIdRef.current) return;

    const opVoice = voice;
    const curIdx = currentChunkRef.current;
    const wasPlaying = isPlayingRef.current;
    // Downloads queued for the previous voice are now useless.
    cancelPrefetches();
    requestWarm(curIdx);
    setState((s) => ({ ...s, voiceLoading: true }));

    (async () => {
      // fetchData caches under the new-voice key; old voice keeps playing meanwhile.
      let data: LoadedChunk | null;
      try {
        data = await fetchData(curIdx);
      } catch {
        setState((s) => ({ ...s, voiceLoading: false }));
        return;
      }
      // Bail if the user moved on (navigated/changed voice again) while we waited.
      if (!data || voiceRef.current !== opVoice || currentChunkRef.current !== curIdx) {
        setState((s) => ({ ...s, voiceLoading: false }));
        return;
      }
      const buffer = await decode(data);
      if (!buffer || voiceRef.current !== opVoice || currentChunkRef.current !== curIdx) {
        setState((s) => ({ ...s, voiceLoading: false }));
        return;
      }

      const resumeAt = Math.min(currentMediaTime(), Math.max(0, buffer.duration - 0.02));
      const gen = ++genRef.current; // now invalidate the old (still-playing) source
      stopCurrentSource();

      currentWordsRef.current = data.words;
      durationRef.current = buffer.duration;
      pauseOffsetRef.current = resumeAt;
      playedRef.current = resumeAt;
      lastWordRef.current = -1;
      setState((s) => ({
        ...s,
        duration: buffer.duration,
        currentTime: resumeAt,
        activeWord: -1,
        voiceLoading: false,
      }));

      if (wasPlaying) {
        startSource(buffer, resumeAt, gen);
        isPlayingRef.current = true;
        setState((s) => ({ ...s, isPlaying: true }));
      }
      preloadNextRef.current();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, docId]);

  const play = useCallback(async () => {
    const ctx = getCtx();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    const idx = currentChunkRef.current;
    const data = cacheRef.current.get(cacheKey(voiceRef.current, idx));
    if (data?.audioBuffer) {
      const gen = ++genRef.current;
      stopCurrentSource();
      startSource(data.audioBuffer, pauseOffsetRef.current, gen);
      isPlayingRef.current = true;
      setState((s) => ({ ...s, isPlaying: true }));
      preloadNextRef.current();
    } else {
      await playChunk(idx, pauseOffsetRef.current || 0, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = useCallback(() => {
    const at = currentMediaTime();
    pauseOffsetRef.current = at;
    stopCurrentSource();
    isPlayingRef.current = false;
    setState((s) => ({ ...s, isPlaying: false, currentTime: at }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(() => {
    if (isPlayingRef.current) pause();
    else void play();
  }, [play, pause]);

  const seek = useCallback((time: number) => {
    const dur = durationRef.current;
    const t = Math.max(0, Math.min(time, dur || time));
    pauseOffsetRef.current = t;
    playedRef.current = t;
    lastWordRef.current = -1;
    if (isPlayingRef.current) {
      const buffer = cacheRef.current.get(
        cacheKey(voiceRef.current, currentChunkRef.current),
      )?.audioBuffer;
      if (buffer) {
        const gen = ++genRef.current;
        stopCurrentSource();
        startSource(buffer, t, gen);
      }
    }
    setState((s) => ({ ...s, currentTime: t, activeWord: -1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skip = useCallback(
    (delta: number) => {
      const cur = currentMediaTime();
      const target = cur + delta;
      const dur = durationRef.current;
      if (target < 0 && currentChunkRef.current > 0) {
        void playChunk(currentChunkRef.current - 1, 9999, isPlayingRef.current);
      } else if (target > dur && currentChunkRef.current < numChunksRef.current - 1) {
        void playChunk(currentChunkRef.current + 1, 0, isPlayingRef.current);
      } else {
        seek(target);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seek],
  );

  const setRate = useCallback((rate: number) => {
    rateRef.current = rate;
    if (shifterRef.current) {
      shifterRef.current.tempo = rate; // live, pitch preserved
      rescheduleEndRef.current?.(); // remaining real-time changed with tempo
    }
    setState((s) => ({ ...s, rate }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToChunk = useCallback((index: number, seekTime = 0, autoplay = true) => {
    void playChunk(index, seekTime, autoplay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const jumpToWord = useCallback(
    (chunkIndex: number, wordIndex: number) => {
      if (chunkIndex === currentChunkRef.current) {
        // Same block: timings are already loaded, so jump instantly.
        const start = currentWordsRef.current[wordIndex]?.start ?? 0;
        seek(start);
        if (!isPlayingRef.current) void play();
      } else {
        // Different block: stop current playback immediately (playChunk halts
        // the current source before fetching) and start at the clicked word.
        void playChunk(chunkIndex, 0, true, wordIndex);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seek, play],
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
