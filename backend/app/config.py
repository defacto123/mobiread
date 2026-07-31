from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration sourced from environment variables.

    A local `.env` file is read for development; in Cloud Run the values are
    injected as environment variables / Secret Manager references.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Deep Infra
    deepinfra_token: str = ""
    deepinfra_base_url: str = "https://api.deepinfra.com/v1/inference"

    # TTS engine selection + default voice
    # Engines: "local_kokoro" (self-hosted ONNX), "deepinfra_kokoro" (managed), "mock"
    tts_engine: str = "local_kokoro"
    tts_voice: str = "bf_emma"
    tts_model: str = "hexgrad/Kokoro-82M"

    # Self-hosted Kokoro (ONNX) model files. Baked into the image at /models.
    kokoro_model_path: str = "/models/kokoro-v1.0.onnx"
    kokoro_voices_path: str = "/models/voices-v1.0.bin"
    kokoro_lang: str = "en-us"
    # ONNX Runtime intra-op threads. 0 = derive from the container's CPU limit
    # (see local_kokoro), which avoids the thread oversubscription that happens
    # when ONNX sizes its pool from the host's core count.
    onnx_intra_op_threads: int = 0

    # Alignment: "proportional" (no extra deps) or "whisperx" (accurate, heavy)
    enable_alignment: bool = True
    align_backend: str = "proportional"
    align_language: str = "en"

    # Chunking
    chunk_target_chars: int = 400

    # Synthesis concurrency. Kokoro on CPU saturates the cores quickly, so total
    # parallelism is capped and background pre-warming is kept below it, leaving
    # a slot free for user-initiated (foreground) requests.
    synth_max_concurrency: int = 2
    synth_max_background: int = 1

    # Cache of synthesized audio (uncompressed WAV, ~48 KB per second of audio).
    audio_cache_mb: int = 600

    # Background pre-generation. Documents at or below `prewarm_full_max_chunks`
    # are generated in full; longer ones only keep `prewarm_window_chunks`
    # generated ahead of the reader.
    prewarm_enabled: bool = True
    prewarm_full_max_chunks: int = 120
    prewarm_window_chunks: int = 24

    # CORS
    cors_origins: str = "http://localhost:5173"
    # Optional regex of allowed origins (e.g. all of this service's Cloud Run
    # URLs). Matched in addition to the exact cors_origins list.
    cors_origin_regex: str = ""

    # Networking
    request_timeout_seconds: int = 120

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
