import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAlibabaVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  description: "Bundled Alibaba Model Studio video provider plugin",
  id: "alibaba",
  name: "Alibaba Model Studio Plugin",
  register(api) {
    api.registerVideoGenerationProvider(buildAlibabaVideoGenerationProvider());
  },
});
