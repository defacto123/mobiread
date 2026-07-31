export interface Voice {
  id: string;
  label: string;
}

/** English Kokoro voices offered in the UI (2 female, 2 male, mixed accents). */
export const VOICES: Voice[] = [
  { id: "bf_emma", label: "Emma (UK, female)" },
  { id: "af_bella", label: "Bella (US, female)" },
  { id: "bm_george", label: "George (UK, male)" },
  { id: "am_michael", label: "Michael (US, male)" },
];

export const DEFAULT_VOICE = VOICES[0].id;
