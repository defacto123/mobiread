# Deploying MobiRead to GCP Cloud Run

Two CPU-only, scale-to-zero Cloud Run services:

- `mobiread-backend` — FastAPI + **self-hosted Kokoro-82M (ONNX, CPU)**. The model
  is baked into the image; no GPU, no external TTS API.
- `mobiread-frontend` — static React SPA served by nginx.

> Per repo policy, deployment happens via **CI/CD on merge to `main`** (GitHub
> Actions), not from the IDE.

## Recommended path: GitHub Actions CI/CD

On every merge to `main`, [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
builds + deploys both services and wires up CORS automatically.

### One-time GCP setup

```bash
export PROJECT_ID=your-project
export REGION=europe-west1
export REPO=mobiread

gcloud config set project "$PROJECT_ID"

# Enable APIs
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com

# Artifact Registry repo for images
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker --location="$REGION"

# Deploy service account for GitHub Actions
gcloud iam service-accounts create mobiread-deployer \
  --display-name="MobiRead CI deployer"

SA="mobiread-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
for ROLE in roles/run.admin roles/cloudbuild.builds.editor \
            roles/artifactregistry.writer roles/iam.serviceAccountUser \
            roles/storage.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA}" --role="$ROLE"
done

# Key for the GitHub secret (rotate/disable after, or prefer Workload Identity)
gcloud iam service-accounts keys create key.json --iam-account="$SA"
```

### Required GitHub repository secrets

| Secret | Value |
|---|---|
| `GCP_PROJECT_ID` | your project id |
| `GCP_REGION` | e.g. `europe-west1` |
| `GCP_SA_KEY` | full contents of `key.json` |

```bash
gh secret set GCP_PROJECT_ID --body "$PROJECT_ID"
gh secret set GCP_REGION     --body "$REGION"
gh secret set GCP_SA_KEY     < key.json
rm key.json   # don't keep the key on disk
```

> Security note: for production prefer **Workload Identity Federation** over a
> long-lived SA key — swap the `auth` step's `credentials_json` for
> `workload_identity_provider` + `service_account`.

Then merge a PR into `main` (or use the workflow's "Run workflow" button). The run
summary prints both service URLs.

## Manual deploy (fallback)

Self-hosted backend (no secrets needed — TTS runs in-container):

```bash
gcloud builds submit ./backend \
  --tag "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/backend:latest"

gcloud run deploy mobiread-backend \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/backend:latest" \
  --region="$REGION" --allow-unauthenticated \
  --cpu=4 --memory=4Gi --min-instances=0 --max-instances=10 \
  --concurrency=1 --timeout=600 \
  --set-env-vars=TTS_ENGINE=local_kokoro,TTS_VOICE=af_bella,KOKORO_LANG=en-us,ALIGN_BACKEND=proportional,ENABLE_ALIGNMENT=true

BACKEND_URL=$(gcloud run services describe mobiread-backend \
  --region="$REGION" --format='value(status.url)')

# Frontend (API URL baked in at build time)
gcloud builds submit ./frontend --config=/dev/stdin <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build','--build-arg','VITE_API_BASE=${BACKEND_URL}','-t','${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/frontend:latest','.']
images: ['${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/frontend:latest']
EOF

gcloud run deploy mobiread-frontend \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/frontend:latest" \
  --region="$REGION" --allow-unauthenticated \
  --cpu=1 --memory=512Mi --min-instances=0 --max-instances=10

FRONTEND_URL=$(gcloud run services describe mobiread-frontend \
  --region="$REGION" --format='value(status.url)')

gcloud run services update mobiread-backend --region="$REGION" \
  --update-env-vars=CORS_ORIGINS="$FRONTEND_URL"
```

## How the model is hosted

- The backend `Dockerfile` downloads `kokoro-v1.0.onnx` (~310 MB) and
  `voices-v1.0.bin` (~26 MB) at **build time** into `/models`, so the container
  starts with the model already present (no runtime download).
- Inference runs on CPU via ONNX Runtime. `--concurrency=1` keeps each CPU-bound
  request on its own instance; Cloud Run scales instances horizontally.
- Cold start loads the model into memory (~5–10s). Set `--min-instances=1` if you
  want to avoid cold starts (small always-on cost).

## Tuning notes

- **Faster/cheaper at scale**: move the backend to an L4 GPU Cloud Run service and
  add `onnxruntime-gpu`, or split TTS into its own service.
- **Accurate karaoke**: build backend with `--build-arg WITH_WHISPERX=1` and set
  `ALIGN_BACKEND=whisperx`.
- **Scale-to-zero**: `--min-instances=0` (default) means no cost when idle.
