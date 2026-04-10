import {
  type MediaUnderstandingProvider,
  transcribeOpenAiCompatibleAudio,
} from "openclaw/plugin-sdk/media-understanding";

const DEFAULT_MISTRAL_AUDIO_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_MISTRAL_AUDIO_MODEL = "voxtral-mini-latest";

export const mistralMediaUnderstandingProvider: MediaUnderstandingProvider = {
  autoPriority: { audio: 50 },
  capabilities: ["audio"],
  defaultModels: { audio: DEFAULT_MISTRAL_AUDIO_MODEL },
  id: "mistral",
  transcribeAudio: async (req) =>
    await transcribeOpenAiCompatibleAudio({
      ...req,
      baseUrl: req.baseUrl ?? DEFAULT_MISTRAL_AUDIO_BASE_URL,
      defaultBaseUrl: DEFAULT_MISTRAL_AUDIO_BASE_URL,
      defaultModel: DEFAULT_MISTRAL_AUDIO_MODEL,
    }),
};
