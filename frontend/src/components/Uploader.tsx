import { useRef, useState } from "react";

interface Props {
  onFile: (file: File) => void;
  busy: boolean;
}

export function Uploader({ onFile, busy }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onFile(file);
  };

  return (
    <div
      className={`uploader ${dragging ? "uploader--drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      <div className="uploader__icon">{busy ? "..." : "PDF"}</div>
      <div className="uploader__title">
        {busy ? "Reading your PDF..." : "Drop a PDF here or click to upload"}
      </div>
      <div className="uploader__hint">Any PDF with selectable text works.</div>
    </div>
  );
}
