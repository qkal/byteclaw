import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildComfyImageGenerationProvider } from "./image-generation-provider.js";
import { buildComfyMusicGenerationProvider } from "./music-generation-provider.js";
import { buildComfyVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "comfy";

export default definePluginEntry({
  description: "Bundled ComfyUI workflow media generation provider",
  id: PROVIDER_ID,
  name: "ComfyUI Provider",
  register(api) {
    api.registerProvider({
      auth: [],
      docsPath: "/providers/comfy",
      envVars: ["COMFY_API_KEY", "COMFY_CLOUD_API_KEY"],
      id: PROVIDER_ID,
      label: "ComfyUI",
    });
    api.registerImageGenerationProvider(buildComfyImageGenerationProvider());
    api.registerMusicGenerationProvider(buildComfyMusicGenerationProvider());
    api.registerVideoGenerationProvider(buildComfyVideoGenerationProvider());
  },
});
