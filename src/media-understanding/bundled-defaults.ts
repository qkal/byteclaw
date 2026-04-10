import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingCapability } from "./types.js";

interface BundledMediaProviderDefaults {
  defaultModels?: Partial<Record<MediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<MediaUnderstandingCapability, number>>;
  nativeDocumentInputs?: "pdf"[];
}

const BUNDLED_MEDIA_PROVIDER_DEFAULTS: Record<string, BundledMediaProviderDefaults> = {
  anthropic: {
    autoPriority: { image: 20 },
    defaultModels: { image: "claude-opus-4-6" },
    nativeDocumentInputs: ["pdf"],
  },
  deepgram: {
    autoPriority: { audio: 30 },
    defaultModels: { audio: "nova-3" },
  },
  google: {
    autoPriority: { audio: 40, image: 30, video: 10 },
    defaultModels: {
      audio: "gemini-3-flash-preview",
      image: "gemini-3-flash-preview",
      video: "gemini-3-flash-preview",
    },
    nativeDocumentInputs: ["pdf"],
  },
  groq: {
    autoPriority: { audio: 20 },
    defaultModels: { audio: "whisper-large-v3-turbo" },
  },
  minimax: {
    autoPriority: { image: 40 },
    defaultModels: { image: "MiniMax-VL-01" },
  },
  "minimax-portal": {
    autoPriority: { image: 50 },
    defaultModels: { image: "MiniMax-VL-01" },
  },
  mistral: {
    autoPriority: { audio: 50 },
    defaultModels: { audio: "voxtral-mini-latest" },
  },
  moonshot: {
    autoPriority: { video: 20 },
    defaultModels: { image: "kimi-k2.5", video: "kimi-k2.5" },
  },
  openai: {
    autoPriority: { audio: 10, image: 10 },
    defaultModels: { audio: "gpt-4o-transcribe", image: "gpt-5.4-mini" },
  },
  "openai-codex": {
    defaultModels: { image: "gpt-5.4" },
  },
  openrouter: {
    defaultModels: { image: "auto" },
  },
  qwen: {
    autoPriority: { video: 15 },
    defaultModels: { image: "qwen-vl-max-latest", video: "qwen-vl-max-latest" },
  },
  zai: {
    autoPriority: { image: 60 },
    defaultModels: { image: "glm-4.6v" },
  },
};

export function getBundledMediaProviderDefaults(
  providerId: string,
): BundledMediaProviderDefaults | null {
  return BUNDLED_MEDIA_PROVIDER_DEFAULTS[normalizeMediaProviderId(providerId)] ?? null;
}

export function resolveBundledDefaultMediaModel(params: {
  providerId: string;
  capability: MediaUnderstandingCapability;
}): string | undefined {
  return getBundledMediaProviderDefaults(params.providerId)?.defaultModels?.[
    params.capability
  ]?.trim();
}

export function resolveBundledAutoMediaKeyProviders(
  capability: MediaUnderstandingCapability,
): string[] {
  return Object.entries(BUNDLED_MEDIA_PROVIDER_DEFAULTS)
    .map(([providerId, defaults]) => ({
      priority: defaults.autoPriority?.[capability],
      providerId,
    }))
    .filter(
      (entry): entry is { providerId: string; priority: number } =>
        typeof entry.priority === "number",
    )
    .toSorted((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.providerId.localeCompare(right.providerId);
    })
    .map((entry) => entry.providerId);
}

export function bundledProviderSupportsNativePdfDocument(providerId: string): boolean {
  return (
    getBundledMediaProviderDefaults(providerId)?.nativeDocumentInputs?.includes("pdf") ?? false
  );
}
