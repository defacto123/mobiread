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

/** Client-side cache entry for a synthesized chunk. */
export interface LoadedChunk {
  index: number;
  audioUrl: string;
  duration: number;
  words: WordTiming[];
}
