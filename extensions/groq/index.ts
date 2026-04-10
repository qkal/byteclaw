import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { groqMediaUnderstandingProvider } from "./media-understanding-provider.js";

export default definePluginEntry({
  description: "Bundled Groq audio transcription provider",
  id: "groq",
  name: "Groq Media Understanding",
  register(api) {
    api.registerMediaUnderstandingProvider(groqMediaUnderstandingProvider);
  },
});
