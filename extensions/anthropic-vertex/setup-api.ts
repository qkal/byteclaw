import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAnthropicVertexConfigApiKey } from "./region.js";

export default definePluginEntry({
  description: "Lightweight Anthropic Vertex setup hooks",
  id: "anthropic-vertex",
  name: "Anthropic Vertex Setup",
  register(api) {
    api.registerProvider({
      auth: [],
      id: "anthropic-vertex",
      label: "Anthropic Vertex",
      resolveConfigApiKey: ({ env }) => resolveAnthropicVertexConfigApiKey(env),
    });
  },
});
