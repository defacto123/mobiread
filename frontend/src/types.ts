export interface UploadResponse {
  doc_id: string;
  num_chunks: number;
  chunks: string[];
  num_pages: number;
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface ChunkResponse {
  doc_id: string;
  index: number;
  text: string;
  audio_b64: string;
  audio_mime: string;
  duration: number;
  words: WordTiming[];
}

/** Progress of the backend's background pre-generation for a document. */
export interface WarmStatus {
  doc_id: string;
  voice: string;
  ready: number;
  total: number;
  num_chunks: number;
  full_document: boolean;
}

/** Client-side cache entry for a synthesized chunk.
 *
 * `bytes` holds the raw (encoded) audio so it can be decoded by the Web Audio
 * API; `audioBuffer` caches the decoded PCM so re-playing/seeking is instant. */
export interface LoadedChunk {
  index: number;
  bytes: ArrayBuffer;
  audioBuffer: AudioBuffer | null;
  duration: number;
  words: WordTiming[];
}
