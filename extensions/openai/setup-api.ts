import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICodexCliBackend } from "./cli-backend.js";

export default definePluginEntry({
  description: "Lightweight OpenAI setup hooks",
  id: "openai",
  name: "OpenAI Setup",
  register(api) {
    api.registerCliBackend(buildOpenAICodexCliBackend());
  },
});
