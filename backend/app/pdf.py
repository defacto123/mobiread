"""PDF text extraction, cleaning, and sentence-boundary chunking.

The goal is to turn an arbitrary PDF into clean, speakable chunks: strip page
numbers, fix hyphenated line breaks, collapse layout whitespace, and split into
chunks of roughly `target_chars` that end on sentence boundaries so each audio
segment is a natural unit for playback and karaoke navigation.
"""

from __future__ import annotations

import re

import fitz  # PyMuPDF


_PAGE_NUMBER_RE = re.compile(r"^\s*(page\s+)?\d+(\s*/\s*\d+)?\s*$", re.IGNORECASE)
_HYPHEN_BREAK_RE = re.compile(r"(\w)-\n(\w)")
_MULTISPACE_RE = re.compile(r"[ \t]+")
_MULTINEWLINE_RE = re.compile(r"\n{2,}")
# Split on sentence-ending punctuation followed by whitespace.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def extract_text(pdf_bytes: bytes) -> tuple[str, int]:
    """Extract cleaned text from PDF bytes. Returns (text, num_pages)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        pages: list[str] = []
        for page in doc:
            raw = page.get_text("text")
            pages.append(_clean_page(raw))
        num_pages = doc.page_count
    finally:
        doc.close()

    text = "\n".join(p for p in pages if p.strip())
    return _normalize(text), num_pages


def _clean_page(raw: str) -> str:
    """Remove obvious non-spoken artifacts from a single page's text."""
    # Re-join words split across line breaks by hyphenation.
    raw = _HYPHEN_BREAK_RE.sub(r"\1\2", raw)

    kept_lines: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            kept_lines.append("")
            continue
        # Drop standalone page numbers / "Page 3 of 47" style lines.
        if _PAGE_NUMBER_RE.match(stripped):
            continue
        kept_lines.append(stripped)
    return "\n".join(kept_lines)


def _normalize(text: str) -> str:
    text = _MULTISPACE_RE.sub(" ", text)
    # Join intra-paragraph line breaks into spaces, keep paragraph breaks.
    text = _MULTINEWLINE_RE.sub("\u2029", text)  # temporary paragraph marker
    text = text.replace("\n", " ")
    text = text.replace("\u2029", "\n\n")
    text = _MULTISPACE_RE.sub(" ", text)
    return text.strip()


def split_sentences(text: str) -> list[str]:
    sentences: list[str] = []
    for paragraph in text.split("\n\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        for sentence in _SENTENCE_SPLIT_RE.split(paragraph):
            sentence = sentence.strip()
            if sentence:
                sentences.append(sentence)
    return sentences


def chunk_text(text: str, target_chars: int = 400) -> list[str]:
    """Group sentences into chunks of roughly `target_chars` characters.

    Never splits mid-sentence. A single sentence longer than the target becomes
    its own chunk (and is hard-wrapped only if it exceeds twice the target).
    """
    sentences = split_sentences(text)
    chunks: list[str] = []
    current = ""

    for sentence in sentences:
        if len(sentence) > target_chars * 2:
            if current:
                chunks.append(current.strip())
                current = ""
            chunks.extend(_hard_wrap(sentence, target_chars))
            continue

        if not current:
            current = sentence
        elif len(current) + 1 + len(sentence) <= target_chars:
            current = f"{current} {sentence}"
        else:
            chunks.append(current.strip())
            current = sentence

    if current.strip():
        chunks.append(current.strip())

    return [c for c in chunks if c.strip()]


def _hard_wrap(sentence: str, target_chars: int) -> list[str]:
    """Wrap an overly long sentence on word boundaries as a last resort."""
    words = sentence.split()
    parts: list[str] = []
    current = ""
    for word in words:
        if not current:
            current = word
        elif len(current) + 1 + len(word) <= target_chars:
            current = f"{current} {word}"
        else:
            parts.append(current)
            current = word
    if current:
        parts.append(current)
    return parts
