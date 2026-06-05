# MobiRead

Upload any PDF and listen to it read aloud, with **karaoke-style word highlighting**
and full playback controls. Built to run on **GCP Cloud Run** (CPU-only,
scale-to-zero). Text-to-speech uses the lightweight open **Kokoro-82M** model,
**self-hosted in-container via ONNX Runtime** (no GPU, no external API). Word
timing for karaoke is produced locally.

## Features

- Upload any text-based PDF (drag-and-drop or click).
- Clean extraction (strips page numbers, fixes hyphenated line breaks) and
  sentence-boundary chunking.
- Custom audio player: play/pause, rewind/forward 10s, speed 0.5x–2x, seekable
  progress bar, and section navigation.
- Karaoke: the word being spoken is highlighted; click any word to jump there;
  the view auto-scrolls to follow along.
- Swappable TTS engine behind a single interface (`TTSEngine`).

## Architecture

```
Browser (React SPA)  ──►  Cloud Run: FastAPI (CPU)
       ▲  audio + word timings        │  PyMuPDF extract/clean/chunk
       │                              │  Kokoro-82M ONNX (in-container, CPU)
       └────────────────────────────  │  + word alignment (proportional | WhisperX)
```

Per chunk: extract text → synthesize audio (self-hosted Kokoro ONNX) → align words
→ return audio + timings. The frontend plays chunks sequentially and prefetches the
next one. No audio caching in v1 (documented as the top future optimization).

### Swappable TTS engines (`TTS_ENGINE`)

| Value | What |
|---|---|
| `local_kokoro` (default) | Self-hosted Kokoro-82M via ONNX Runtime, CPU, no API |
| `deepinfra_kokoro` | Managed Kokoro via Deep Infra API (needs `DEEPINFRA_TOKEN`) |
| `mock` | Offline test tone, no model/token (local dev) |

## Project layout

| Path | What |
|---|---|
| `backend/` | FastAPI service (PDF, TTS client, alignment, API) |
| `frontend/` | React + Vite + TypeScript SPA |
| `deploy/` | Cloud Run deploy config + instructions |

## Local development

### Backend

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# Pick a TTS engine:
# (a) Self-hosted Kokoro (default) — install model + deps:
pip install -r requirements-kokoro.txt
mkdir -p models
curl -fsSL https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx -o models/kokoro-v1.0.onnx
curl -fsSL https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin  -o models/voices-v1.0.bin
export TTS_ENGINE=local_kokoro
export KOKORO_MODEL_PATH=models/kokoro-v1.0.onnx KOKORO_VOICES_PATH=models/voices-v1.0.bin

# (b) Or no model at all — offline test tone:
# export TTS_ENGINE=mock

uvicorn app.main:app --reload --port 8000
```

For the managed engine instead, set `TTS_ENGINE=deepinfra_kokoro` and
`DEEPINFRA_TOKEN` (token from https://deepinfra.com/dash/api_keys).

### Frontend

```bash
cd frontend
npm install
cp .env.example .env           # VITE_API_BASE=http://localhost:8000
npm run dev                     # http://localhost:5173
```

## Configuration (backend env vars)

| Var | Default | Purpose |
|---|---|---|
| `TTS_ENGINE` | `local_kokoro` | `local_kokoro` \| `deepinfra_kokoro` \| `mock` |
| `TTS_VOICE` | `af_bella` | Default Kokoro voice |
| `KOKORO_MODEL_PATH` | `/models/kokoro-v1.0.onnx` | Self-hosted ONNX model path |
| `KOKORO_VOICES_PATH` | `/models/voices-v1.0.bin` | Self-hosted voices path |
| `KOKORO_LANG` | `en-us` | Phonemization language |
| `DEEPINFRA_TOKEN` | — | Required only for `deepinfra_kokoro` |
| `ENABLE_ALIGNMENT` | `true` | Produce word timings for karaoke |
| `ALIGN_BACKEND` | `proportional` | `proportional` (light) or `whisperx` (accurate) |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allowed origins |

## Deployment

See [`deploy/README.md`](deploy/README.md). Deploy via Cloud Build / `gcloud`
(not from the IDE).

## Cost & scaling notes

- TTS is billed per character by Deep Infra (Kokoro ≈ $0.62 / 1M chars).
- Cloud Run is CPU-only and scales to zero — no idle cost, no GPU.
- For full-book scale, enabling **audio caching/dedup** is the biggest future
  cost lever (regeneration is the dominant cost in v1).
