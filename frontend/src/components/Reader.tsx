import { memo, useEffect, useMemo, useRef } from "react";

interface ChunkViewProps {
  text: string;
  index: number;
  isActive: boolean;
  activeWord: number;
  onWordClick: (chunkIndex: number, wordIndex: number) => void;
  onActivateChunk: (chunkIndex: number) => void;
}

const ChunkView = memo(function ChunkView({
  text,
  index,
  isActive,
  activeWord,
  onWordClick,
  onActivateChunk,
}: ChunkViewProps) {
  const tokens = useMemo(() => text.match(/\S+/g) ?? [], [text]);
  const activeRef = useRef<HTMLSpanElement | null>(null);
  const containerRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (isActive && activeRef.current) {
      activeRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (isActive && containerRef.current) {
      containerRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [isActive, activeWord]);

  if (!isActive) {
    return (
      <p
        className="reader__chunk"
        onClick={() => onActivateChunk(index)}
        title="Click to read from here"
      >
        {text}
      </p>
    );
  }

  return (
    <p className="reader__chunk reader__chunk--active" ref={containerRef}>
      {tokens.map((tok, i) => (
        <span
          key={i}
          ref={i === activeWord ? activeRef : undefined}
          className={`reader__word ${i === activeWord ? "reader__word--active" : ""}`}
          onClick={() => onWordClick(index, i)}
        >
          {tok}{" "}
        </span>
      ))}
    </p>
  );
});

interface ReaderProps {
  chunks: string[];
  currentChunk: number;
  activeWord: number;
  onWordClick: (chunkIndex: number, wordIndex: number) => void;
  onActivateChunk: (chunkIndex: number) => void;
}

export function Reader({
  chunks,
  currentChunk,
  activeWord,
  onWordClick,
  onActivateChunk,
}: ReaderProps) {
  return (
    <div className="reader">
      {chunks.map((text, i) => (
        <ChunkView
          key={i}
          text={text}
          index={i}
          isActive={i === currentChunk}
          activeWord={i === currentChunk ? activeWord : -1}
          onWordClick={onWordClick}
          onActivateChunk={onActivateChunk}
        />
      ))}
    </div>
  );
}
