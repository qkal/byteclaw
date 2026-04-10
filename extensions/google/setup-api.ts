import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";

export default definePluginEntry({
  description: "Lightweight Google setup hooks",
  id: "google",
  name: "Google Setup",
  register(api) {
    api.registerCliBackend(buildGoogleGeminiCliBackend());
  },
});
