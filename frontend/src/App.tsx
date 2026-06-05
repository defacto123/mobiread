import { useCallback, useState } from "react";

import { uploadPdf } from "./api";
import { Controls } from "./components/Controls";
import { Reader } from "./components/Reader";
import { Uploader } from "./components/Uploader";
import type { UploadResponse } from "./types";
import { usePlayer } from "./usePlayer";

export default function App() {
  const [doc, setDoc] = useState<UploadResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const player = usePlayer(doc?.doc_id ?? null, doc?.num_chunks ?? 0);

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
            onActivateChunk={(i) => player.goToChunk(i, 0, true)}
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
              onToggle={player.toggle}
              onSkip={player.skip}
              onSeek={player.seek}
              onRate={player.setRate}
              onChunk={(i) => player.goToChunk(i, 0, true)}
            />
          </div>
        </main>
      )}
    </div>
  );
}
