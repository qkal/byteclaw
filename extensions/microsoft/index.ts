import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMicrosoftSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  description: "Bundled Microsoft speech provider",
  id: "microsoft",
  name: "Microsoft Speech",
  register(api) {
    api.registerSpeechProvider(buildMicrosoftSpeechProvider());
  },
});
