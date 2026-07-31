import type { ChunkResponse, LoadedChunk, UploadResponse, WarmStatus } from "./types";

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8000";

export async function uploadPdf(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  const resp = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    throw new Error(await readError(resp));
  }
  return resp.json();
}

/** Fetch one chunk's audio + word timings.
 *
 * `text` is sent along so an instance that never received the upload can still
 * serve the request - Cloud Run spreads requests across instances, and the
 * document lives in the memory of whichever one handled the upload. */
export async function fetchChunk(
  docId: string,
  index: number,
  voice?: string,
  signal?: AbortSignal,
  text?: string,
): Promise<LoadedChunk> {
  // text/plain keeps this a CORS "simple request", avoiding an extra preflight
  // round-trip per chunk. FastAPI parses the body from the model regardless.
  const resp = await fetch(`${API_BASE}/chunk/${docId}/${index}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ voice, text }),
    signal,
  });
  if (!resp.ok) {
    throw new Error(await readError(resp));
  }
  const data: ChunkResponse = await resp.json();
  return {
    index: data.index,
    bytes: base64ToArrayBuffer(data.audio_b64),
    audioBuffer: null,
    duration: data.duration,
    words: data.words,
  };
}

/** Ask the backend to pre-generate audio around `start`. Best-effort: the UI
 * works without it, just with more on-demand synthesis.
 *
 * The chunk list is only re-sent when the instance answering says it doesn't
 * know the document, keeping the common call small even for a long book. */
export async function warmDoc(
  docId: string,
  voice: string | undefined,
  start: number,
  chunks?: string[],
): Promise<WarmStatus | null> {
  const post = (body: Record<string, unknown>) =>
    fetch(`${API_BASE}/warm/${docId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
    });

  try {
    let resp = await post({ voice, start });
    if (resp.status === 404 && chunks?.length) {
      resp = await post({ voice, start, chunks });
    }
    if (!resp.ok) return null;
    return (await resp.json()) as WarmStatus;
  } catch {
    return null;
  }
}

async function readError(resp: Response): Promise<string> {
  try {
    const data = await resp.json();
    return data.detail ?? `Request failed (${resp.status})`;
  } catch {
    return `Request failed (${resp.status})`;
  }
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
