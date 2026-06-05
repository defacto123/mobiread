import { memo, useEffect, useMemo, useRef } from "react";

/**
 * Map a character offset within a chunk's text to its word index
 * (whitespace-delimited, matching the backend's `\S+` tokenization).
 */
function offsetToWordIndex(text: string, offset: number): number {
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  let idx = -1;
  while ((match = re.exec(text)) !== null) {
    if (match.index <= offset) idx++;
    else break;
  }
  return Math.max(0, idx);
}

/**
 * Resolve which word was tapped/clicked in a plain paragraph using the caret
 * position at the pointer. Works on mobile (caretRangeFromPoint) and Firefox
 * (caretPositionFromPoint). Falls back to word 0.
 */
function wordIndexFromPoint(text: string, clientX: number, clientY: number): number {
  const doc = document as unknown as {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offset: number } | null;
  };
  let offset: number | null = null;
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    if (range) offset = range.startOffset;
  } else if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(clientX, clientY);
    if (pos) offset = pos.offset;
  }
  if (offset == null) return 0;
  return offsetToWordIndex(text, offset);
}

interface ChunkViewProps {
  text: string;
  index: number;
  isActive: boolean;
  activeWord: number;
  onWordClick: (chunkIndex: number, wordIndex: number) => void;
}

const ChunkView = memo(function ChunkView({
  text,
  index,
  isActive,
  activeWord,
  onWordClick,
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

  // Inactive chunks: render as one light paragraph and resolve the tapped word
  // from the caret position, so a single tap anywhere jumps reading to that word.
  if (!isActive) {
    return (
      <p
        className="reader__chunk"
        title="Tap a word to read from there"
        onClick={(e) => onWordClick(index, wordIndexFromPoint(text, e.clientX, e.clientY))}
      >
        {text}
      </p>
    );
  }

  // Active chunk: per-word spans so we can highlight the spoken word.
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
}

export function Reader({ chunks, currentChunk, activeWord, onWordClick }: ReaderProps) {
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
        />
      ))}
    </div>
  );
}
