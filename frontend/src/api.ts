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

export async function fetchChunk(
  docId: string,
  index: number,
  voice?: string,
  signal?: AbortSignal,
): Promise<LoadedChunk> {
  const url = new URL(`${API_BASE}/chunk/${docId}/${index}`);
  if (voice) url.searchParams.set("voice", voice);

  const resp = await fetch(url.toString(), { signal });
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
 * works without it, just with more on-demand synthesis. */
export async function warmDoc(
  docId: string,
  voice: string | undefined,
  start: number,
): Promise<WarmStatus | null> {
  const url = new URL(`${API_BASE}/warm/${docId}`);
  if (voice) url.searchParams.set("voice", voice);
  url.searchParams.set("start", String(start));
  try {
    const resp = await fetch(url.toString(), { method: "POST" });
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
