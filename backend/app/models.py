from pydantic import BaseModel


class UploadResponse(BaseModel):
    doc_id: str
    num_chunks: int
    chunks: list[str]
    num_pages: int


class WordTiming(BaseModel):
    word: str
    start: float
    end: float


class ChunkResponse(BaseModel):
    doc_id: str
    index: int
    text: str
    audio_b64: str
    audio_mime: str
    duration: float
    words: list[WordTiming]


class ChunkRequest(BaseModel):
    """Chunk request. `text` lets an instance that has never seen the document
    (Cloud Run spreads requests across instances) serve it anyway, instead of
    failing with "document not found"."""

    voice: str | None = None
    text: str | None = None


class WarmRequest(BaseModel):
    """Pre-generation request. `chunks` is only sent when an instance reports it
    doesn't know the document, so the common call stays small."""

    voice: str | None = None
    start: int = 0
    chunks: list[str] | None = None
    num_pages: int = 0


class WarmStatusResponse(BaseModel):
    doc_id: str
    voice: str
    ready: int
    total: int
    num_chunks: int
    full_document: bool


class HealthResponse(BaseModel):
    status: str
    tts_engine: str
    align_backend: str
    alignment_enabled: bool
