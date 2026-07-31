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
