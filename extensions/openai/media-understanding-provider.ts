import {
  type AudioTranscriptionRequest,
  type MediaUnderstandingProvider,
  describeImageWithModel,
  describeImagesWithModel,
  transcribeOpenAiCompatibleAudio,
} from "openclaw/plugin-sdk/media-understanding";
import { OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "./default-models.js";

export const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";

export async function transcribeOpenAiAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiCompatibleAudio({
    ...params,
    defaultBaseUrl: DEFAULT_OPENAI_AUDIO_BASE_URL,
    defaultModel: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
    provider: "openai",
  });
}

export const openaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  autoPriority: { audio: 10, image: 10 },
  capabilities: ["image", "audio"],
  defaultModels: {
    audio: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
    image: "gpt-5.4-mini",
  },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  id: "openai",
  transcribeAudio: transcribeOpenAiAudio,
};

export const openaiCodexMediaUnderstandingProvider: MediaUnderstandingProvider = {
  capabilities: ["image"],
  defaultModels: { image: "gpt-5.4" },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  id: "openai-codex",
};
