"""MobiRead backend API.

Endpoints:
* GET  /health                     - liveness + active engine info
* POST /upload                     - extract + clean + chunk a PDF
* POST /chunk/{doc_id}/{index}     - synthesize + align one chunk (audio + words)
* POST /warm/{doc_id}              - start/retarget background pre-generation
* GET  /warm-status/{doc_id}       - pre-generation progress
"""

from __future__ import annotations

import base64
import logging
import threading
import uuid
from typing import TypeVar

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError

from app.config import get_settings
from app.models import (
    ChunkRequest,
    ChunkResponse,
    HealthResponse,
    UploadResponse,
    WarmRequest,
    WarmStatusResponse,
)
from app.pdf import chunk_text, extract_text
from app.prewarm import prewarm
from app.store import Document, store
from app.synth import get_or_synthesize, get_tts_engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mobiread")

BodyT = TypeVar("BodyT", bound=BaseModel)

settings = get_settings()

app = FastAPI(title="MobiRead API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_origin_regex=settings.cors_origin_regex or None,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

@app.on_event("startup")
def _warm_engine() -> None:
    """Eagerly build the engine and run a tiny synthesis so the (kept-warm)
    instance has the model loaded before the first real request. Runs in a
    background thread and is best-effort: any failure falls back to the normal
    lazy load on the first /chunk request and never blocks startup/health."""

    def _load() -> None:
        try:
            get_tts_engine().synthesize("Warm up.", voice=settings.tts_voice)
            logger.info("TTS engine warmed up")
        except Exception:
            logger.exception("TTS engine warm-up failed (will lazy-load on demand)")

    threading.Thread(target=_load, name="tts-warmup", daemon=True).start()


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


def _require_doc(doc_id: str) -> Document:
    doc = store.get(doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found or expired.")
    return doc


async def _read_body(request: Request, model: type[BodyT]) -> BodyT:
    """Parse a JSON body sent with any content type.

    Clients send `text/plain` so the browser treats these as CORS "simple
    requests" and skips the preflight round-trip on every chunk fetch, which
    means FastAPI won't decode the body for us."""
    raw = await request.body()
    if not raw:
        return model()
    try:
        return model.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid request body: {exc}")


@app.post("/chunk/{doc_id}/{index}", response_model=ChunkResponse)
async def get_chunk(request: Request, doc_id: str, index: int) -> ChunkResponse:
    body = await _read_body(request, ChunkRequest)
    doc = store.get(doc_id)

    # Requests are spread across instances, so this one may not hold the
    # document. The client carries the chunk's text for exactly that case.
    if doc is not None:
        if index < 0 or index >= len(doc.chunks):
            raise HTTPException(status_code=404, detail="Chunk index out of range.")
        text = doc.chunks[index]
    elif body.text:
        text = body.text
    else:
        raise HTTPException(status_code=404, detail="Document not found or expired.")

    selected_voice = body.voice or settings.tts_voice

    # The reader is here, so aim background pre-generation at this position.
    if doc is not None:
        prewarm.ensure(doc, selected_voice, start_index=index)

    # Abandoned requests (the client seeked elsewhere) shouldn't consume a
    # synthesis slot that a live request is waiting for.
    if await request.is_disconnected():
        raise HTTPException(status_code=499, detail="Client disconnected.")

    try:
        chunk = await run_in_threadpool(
            get_or_synthesize, doc_id, index, text, selected_voice, True
        )
    except Exception as exc:
        logger.exception("TTS synthesis failed")
        raise HTTPException(status_code=502, detail=f"TTS failed: {exc}")

    return ChunkResponse(
        doc_id=doc_id,
        index=index,
        text=text,
        audio_b64=base64.b64encode(chunk.audio).decode("ascii"),
        audio_mime=chunk.mime,
        duration=chunk.duration,
        words=chunk.words,
    )


@app.post("/warm/{doc_id}", response_model=WarmStatusResponse)
async def warm(request: Request, doc_id: str) -> WarmStatusResponse:
    """Start (or retarget) background pre-generation for a document.

    An instance that doesn't know this document adopts it from `chunks` when the
    client supplies them, so pre-generation works wherever the request lands."""
    body = await _read_body(request, WarmRequest)
    doc = store.get(doc_id)
    if doc is None:
        if not body.chunks:
            raise HTTPException(status_code=404, detail="Document not found or expired.")
        doc = Document(doc_id=doc_id, chunks=body.chunks, num_pages=body.num_pages)
        store.put(doc)

    selected_voice = body.voice or settings.tts_voice
    prewarm.ensure(doc, selected_voice, start_index=body.start)
    return _warm_status(doc, selected_voice)


@app.get("/warm-status/{doc_id}", response_model=WarmStatusResponse)
def warm_status(doc_id: str, voice: str | None = None) -> WarmStatusResponse:
    doc = _require_doc(doc_id)
    return _warm_status(doc, voice or settings.tts_voice)


def _warm_status(doc: Document, voice: str) -> WarmStatusResponse:
    ready, total = prewarm.status(doc, voice)
    return WarmStatusResponse(
        doc_id=doc.doc_id,
        voice=voice,
        ready=ready,
        total=total,
        num_chunks=len(doc.chunks),
        full_document=len(doc.chunks) <= settings.prewarm_full_max_chunks,
    )
