import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { transcribeDeepgramAudio } from "./audio.js";

export const deepgramMediaUnderstandingProvider: MediaUnderstandingProvider = {
  autoPriority: { audio: 30 },
  capabilities: ["audio"],
  defaultModels: { audio: "nova-3" },
  id: "deepgram",
  transcribeAudio: transcribeDeepgramAudio,
};
