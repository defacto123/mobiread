import { useCallback, useState } from "react";

import { uploadPdf } from "./api";
import { Controls } from "./components/Controls";
import { Reader } from "./components/Reader";
import { Uploader } from "./components/Uploader";
import type { UploadResponse } from "./types";
import { usePlayer } from "./usePlayer";
import { DEFAULT_VOICE } from "./voices";

export default function App() {
  const [doc, setDoc] = useState<UploadResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [voice, setVoice] = useState<string>(DEFAULT_VOICE);

  const player = usePlayer(doc?.doc_id ?? null, doc?.num_chunks ?? 0, voice);

  const handleFile = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const result = await uploadPdf(file);
      setDoc(result);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, []);

  const loadExample = useCallback(async () => {
    setUploading(true);
    setUploadError(null);
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}example.pdf`);
      if (!resp.ok) throw new Error("Could not load the example PDF.");
      const blob = await resp.blob();
      const file = new File([blob], "example.pdf", { type: "application/pdf" });
      const result = await uploadPdf(file);
      setDoc(result);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to load example");
    } finally {
      setUploading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setDoc(null);
    setUploadError(null);
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__logo">MobiRead</h1>
        <p className="app__tagline">Upload a PDF and listen along, karaoke-style.</p>
        {doc && (
          <button className="btn btn--ghost" onClick={reset}>
            New PDF
          </button>
        )}
      </header>

      {!doc ? (
        <main className="app__main">
          <Uploader onFile={handleFile} busy={uploading} />
          <div className="app__example">
            <button
              className="btn app__example-btn"
              onClick={loadExample}
              disabled={uploading}
            >
              {uploading ? "Loading..." : "Load example PDF"}
            </button>
            <span className="app__example-hint">
              Try it instantly with a sample research paper.
            </span>
          </div>
          {uploadError && <p className="error">{uploadError}</p>}
        </main>
      ) : (
        <main className="app__main app__main--reading">
          {player.error && <p className="error">{player.error}</p>}
          <Reader
            chunks={doc.chunks}
            currentChunk={player.currentChunk}
            activeWord={player.activeWord}
            onWordClick={player.jumpToWord}
          />
          <div className="app__player">
            <Controls
              isPlaying={player.isPlaying}
              loading={player.loading}
              currentTime={player.currentTime}
              duration={player.duration}
              rate={player.rate}
              currentChunk={player.currentChunk}
              numChunks={doc.num_chunks}
              voice={voice}
              onToggle={player.toggle}
              onSkip={player.skip}
              onSeek={player.seek}
              onRate={player.setRate}
              onChunk={(i) => player.goToChunk(i, 0, true)}
              onVoice={setVoice}
            />
          </div>
        </main>
      )}
    </div>
  );
}
