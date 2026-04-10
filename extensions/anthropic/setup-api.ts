import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAnthropicCliBackend } from "./cli-backend.js";

export default definePluginEntry({
  description: "Lightweight Anthropic setup hooks",
  id: "anthropic",
  name: "Anthropic Setup",
  register(api) {
    api.registerCliBackend(buildAnthropicCliBackend());
  },
});
