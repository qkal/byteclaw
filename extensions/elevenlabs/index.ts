import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildElevenLabsSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  description: "Bundled ElevenLabs speech provider",
  id: "elevenlabs",
  name: "ElevenLabs Speech",
  register(api) {
    api.registerSpeechProvider(buildElevenLabsSpeechProvider());
  },
});
