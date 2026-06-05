# Backend image for Cloud Run (CPU-only).
#
# Default: self-hosted Kokoro-82M via ONNX Runtime (TTS_ENGINE=local_kokoro).
# The model files are baked into /models so there is no cold-start download.
#
# Optional accurate karaoke: build with --build-arg WITH_WHISPERX=1 and set
# ALIGN_BACKEND=whisperx (larger image, pulls torch).
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# espeak-ng: phonemization backend used by Kokoro for out-of-dictionary words.
# curl: fetch model files at build time. ffmpeg: only needed by WhisperX.
ARG WITH_WHISPERX=0
RUN apt-get update && \
    apt-get install -y --no-install-recommends espeak-ng curl && \
    if [ "$WITH_WHISPERX" = "1" ]; then apt-get install -y --no-install-recommends ffmpeg; fi && \
    rm -rf /var/lib/apt/lists/*

# Python dependencies (core + self-hosted Kokoro; optional WhisperX).
COPY requirements.txt requirements-kokoro.txt requirements-whisperx.txt ./
RUN pip install -r requirements.txt && \
    pip install -r requirements-kokoro.txt && \
    if [ "$WITH_WHISPERX" = "1" ]; then pip install -r requirements-whisperx.txt; fi

# Bake the Kokoro ONNX model + voices into the image.
ARG KOKORO_RELEASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
RUN mkdir -p /models && \
    curl -fsSL "${KOKORO_RELEASE}/kokoro-v1.0.onnx" -o /models/kokoro-v1.0.onnx && \
    curl -fsSL "${KOKORO_RELEASE}/voices-v1.0.bin" -o /models/voices-v1.0.bin

COPY app ./app

# Defaults: self-hosted Kokoro on CPU.
ENV PORT=8080 \
    TTS_ENGINE=local_kokoro \
    TTS_VOICE=af_bella \
    KOKORO_MODEL_PATH=/models/kokoro-v1.0.onnx \
    KOKORO_VOICES_PATH=/models/voices-v1.0.bin \
    KOKORO_LANG=en-us \
    ALIGN_BACKEND=proportional \
    ENABLE_ALIGNMENT=true

EXPOSE 8080

CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1
