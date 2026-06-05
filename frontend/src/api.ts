import type { ChunkResponse, LoadedChunk, UploadResponse } from "./types";

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
): Promise<LoadedChunk> {
  const url = new URL(`${API_BASE}/chunk/${docId}/${index}`);
  if (voice) url.searchParams.set("voice", voice);

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    throw new Error(await readError(resp));
  }
  const data: ChunkResponse = await resp.json();
  const audioUrl = base64ToObjectUrl(data.audio_b64, data.audio_mime);
  return {
    index: data.index,
    audioUrl,
    duration: data.duration,
    words: data.words,
  };
}

async function readError(resp: Response): Promise<string> {
  try {
    const data = await resp.json();
    return data.detail ?? `Request failed (${resp.status})`;
  } catch {
    return `Request failed (${resp.status})`;
  }
}

function base64ToObjectUrl(b64: string, mime: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mime || "audio/wav" });
  return URL.createObjectURL(blob);
}
