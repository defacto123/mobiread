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
# Leading list-bullet glyphs that should not be spoken.
_BULLET_RE = re.compile(r"^[\u2022\u25AA\u25CF\u2023\u25E6\u2043\u2219\u00B7\u2027]\s*")
# Split on sentence-ending punctuation followed by whitespace.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

# Fraction of page height treated as header/footer margin, and the max length a
# margin block may have to be considered boilerplate (running head / page no.).
_MARGIN_FRACTION = 0.08
_MARGIN_BLOCK_MAX_CHARS = 80


def extract_text(pdf_bytes: bytes) -> tuple[str, int]:
    """Extract cleaned text from PDF bytes. Returns (text, num_pages)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        pages: list[str] = []
        for page in doc:
            raw = _page_text_in_reading_order(page)
            pages.append(_clean_page(raw))
        num_pages = doc.page_count
    finally:
        doc.close()

    text = "\n".join(p for p in pages if p.strip())
    return _normalize(text), num_pages


def _page_text_in_reading_order(page) -> str:
    """Extract a page's text in human reading order.

    PyMuPDF's plain `get_text("text")` follows the PDF content stream, which on
    multi-column layouts interleaves columns and emits running headers/footers
    out of place. Instead we work with positioned text blocks: drop short
    header/footer blocks in the page margins, and on two-column pages read the
    left column top-to-bottom, then the right column.
    """
    rect = page.rect
    width, height = rect.width, rect.height
    mid_x = rect.x0 + width / 2
    top_band = rect.y0 + _MARGIN_FRACTION * height
    bottom_band = rect.y1 - _MARGIN_FRACTION * height

    blocks = [b for b in page.get_text("blocks") if b[6] == 0 and b[4].strip()]
    if not blocks:
        return ""

    body: list = []
    for b in blocks:
        _x0, y0, _x1, y1, txt = b[0], b[1], b[2], b[3], b[4]
        in_margin = y1 <= top_band or y0 >= bottom_band
        # Only drop boilerplate-sized blocks in the margins; keep long body text
        # that merely starts/ends near an edge.
        if in_margin and len(txt.strip()) < _MARGIN_BLOCK_MAX_CHARS:
            continue
        body.append(b)
    if not body:
        body = blocks

    gutter = 0.08 * width

    def center(b) -> float:
        return (b[0] + b[2]) / 2

    left = [b for b in body if center(b) < mid_x - gutter]
    right = [b for b in body if center(b) > mid_x + gutter]
    spanning = [b for b in body if mid_x - gutter <= center(b) <= mid_x + gutter]

    if len(left) >= 2 and len(right) >= 2:
        # Two columns: full-width (spanning) blocks flow with the left column.
        ordered = sorted(left + spanning, key=lambda b: b[1]) + sorted(right, key=lambda b: b[1])
    else:
        # Single column (or ambiguous): top-to-bottom, then left-to-right.
        ordered = sorted(body, key=lambda b: (round(b[1]), b[0]))

    return "\n".join(b[4].strip() for b in ordered)


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
        # Strip a leading list-bullet glyph ("• item" -> "item").
        stripped = _BULLET_RE.sub("", stripped).strip()
        if not stripped:
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
