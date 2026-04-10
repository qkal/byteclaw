import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { deepgramMediaUnderstandingProvider } from "./media-understanding-provider.js";

export default definePluginEntry({
  description: "Bundled Deepgram audio transcription provider",
  id: "deepgram",
  name: "Deepgram Media Understanding",
  register(api) {
    api.registerMediaUnderstandingProvider(deepgramMediaUnderstandingProvider);
  },
});
