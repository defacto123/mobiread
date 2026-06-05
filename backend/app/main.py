"""MobiRead backend API.

Endpoints:
* GET  /health                     - liveness + active engine info
* POST /upload                     - extract + clean + chunk a PDF
* GET  /chunk/{doc_id}/{index}     - synthesize + align one chunk (audio + words)
"""

from __future__ import annotations

import base64
import logging
import uuid

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.align import align_words
from app.config import get_settings
from app.models import ChunkResponse, HealthResponse, UploadResponse
from app.pdf import chunk_text, extract_text
from app.store import Document, store
from app.tts import TTSEngine, get_engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mobiread")

settings = get_settings()

app = FastAPI(title="MobiRead API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_engine: TTSEngine | None = None


def _get_engine() -> TTSEngine:
    """Lazily build the TTS engine so the app can boot for health checks
    even before secrets are wired."""
    global _engine
    if _engine is None:
        _engine = get_engine(settings)
    return _engine


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        tts_engine=settings.tts_engine,
        align_backend=settings.align_backend,
        alignment_enabled=settings.enable_alignment,
    )


@app.post("/upload", response_model=UploadResponse)
def upload(file: UploadFile = File(...)) -> UploadResponse:
    filename = (file.filename or "").lower()
    if not filename.endswith(".pdf") and file.content_type not in (
        "application/pdf",
        "application/octet-stream",
    ):
        raise HTTPException(status_code=400, detail="Please upload a PDF file.")

    pdf_bytes = file.file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        text, num_pages = extract_text(pdf_bytes)
    except Exception as exc:
        logger.exception("PDF extraction failed")
        raise HTTPException(status_code=422, detail=f"Could not read PDF: {exc}")

    chunks = chunk_text(text, target_chars=settings.chunk_target_chars)
    if not chunks:
        raise HTTPException(
            status_code=422,
            detail="No readable text found in this PDF (it may be scanned images).",
        )

    doc_id = uuid.uuid4().hex
    store.put(Document(doc_id=doc_id, chunks=chunks, num_pages=num_pages))

    return UploadResponse(
        doc_id=doc_id,
        num_chunks=len(chunks),
        chunks=chunks,
        num_pages=num_pages,
    )


@app.get("/chunk/{doc_id}/{index}", response_model=ChunkResponse)
def get_chunk(doc_id: str, index: int, voice: str | None = None) -> ChunkResponse:
    doc = store.get(doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found or expired.")
    if index < 0 or index >= len(doc.chunks):
        raise HTTPException(status_code=404, detail="Chunk index out of range.")

    text = doc.chunks[index]

    try:
        result = _get_engine().synthesize(text, voice=voice)
    except Exception as exc:
        logger.exception("TTS synthesis failed")
        raise HTTPException(status_code=502, detail=f"TTS failed: {exc}")

    duration, words = align_words(result.audio, text, settings)

    return ChunkResponse(
        doc_id=doc_id,
        index=index,
        text=text,
        audio_b64=base64.b64encode(result.audio).decode("ascii"),
        audio_mime=result.mime,
        duration=duration,
        words=words,
    )
