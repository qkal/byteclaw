import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildRunwayVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  description: "Bundled Runway video provider plugin",
  id: "runway",
  name: "Runway Provider",
  register(api) {
    api.registerVideoGenerationProvider(buildRunwayVideoGenerationProvider());
  },
});
