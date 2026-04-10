import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import { registerGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import { buildGoogleMusicGenerationProvider } from "./music-generation-provider.js";
import { registerGoogleProvider } from "./provider-registration.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";
import { buildGoogleVideoGenerationProvider } from "./video-generation-provider.js";

let googleImageGenerationProviderPromise: Promise<ImageGenerationProvider> | null = null;
let googleMediaUnderstandingProviderPromise: Promise<MediaUnderstandingProvider> | null = null;

type GoogleMediaUnderstandingProvider = MediaUnderstandingProvider & {
  describeImage: NonNullable<MediaUnderstandingProvider["describeImage"]>;
  describeImages: NonNullable<MediaUnderstandingProvider["describeImages"]>;
  transcribeAudio: NonNullable<MediaUnderstandingProvider["transcribeAudio"]>;
  describeVideo: NonNullable<MediaUnderstandingProvider["describeVideo"]>;
};

async function loadGoogleImageGenerationProvider(): Promise<ImageGenerationProvider> {
  if (!googleImageGenerationProviderPromise) {
    googleImageGenerationProviderPromise = import("./image-generation-provider.js").then((mod) =>
      mod.buildGoogleImageGenerationProvider(),
    );
  }
  return await googleImageGenerationProviderPromise;
}

async function loadGoogleMediaUnderstandingProvider(): Promise<MediaUnderstandingProvider> {
  if (!googleMediaUnderstandingProviderPromise) {
    googleMediaUnderstandingProviderPromise = import("./media-understanding-provider.js").then(
      (mod) => mod.googleMediaUnderstandingProvider,
    );
  }
  return await googleMediaUnderstandingProviderPromise;
}

async function loadGoogleRequiredMediaUnderstandingProvider(): Promise<GoogleMediaUnderstandingProvider> {
  const provider = await loadGoogleMediaUnderstandingProvider();
  if (
    !provider.describeImage ||
    !provider.describeImages ||
    !provider.transcribeAudio ||
    !provider.describeVideo
  ) {
    throw new Error("google media understanding provider missing required handlers");
  }
  return provider as GoogleMediaUnderstandingProvider;
}

function createLazyGoogleImageGenerationProvider(): ImageGenerationProvider {
  return {
    capabilities: {
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 5,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
      },
      generate: {
        maxCount: 4,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
      },
      geometry: {
        aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        resolutions: ["1K", "2K", "4K"],
        sizes: ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024"],
      },
    },
    defaultModel: "gemini-3.1-flash-image-preview",
    generateImage: async (req) => (await loadGoogleImageGenerationProvider()).generateImage(req),
    id: "google",
    label: "Google",
    models: ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"],
  };
}

function createLazyGoogleMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    autoPriority: { audio: 40, image: 30, video: 10 },
    capabilities: ["image", "audio", "video"],
    defaultModels: {
      audio: "gemini-3-flash-preview",
      image: "gemini-3-flash-preview",
      video: "gemini-3-flash-preview",
    },
    describeImage: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeImage(...args),
    describeImages: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeImages(...args),
    describeVideo: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeVideo(...args),
    id: "google",
    nativeDocumentInputs: ["pdf"],
    transcribeAudio: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).transcribeAudio(...args),
  };
}

export default definePluginEntry({
  description: "Bundled Google plugin",
  id: "google",
  name: "Google Plugin",
  register(api) {
    api.registerCliBackend(buildGoogleGeminiCliBackend());
    registerGoogleGeminiCliProvider(api);
    registerGoogleProvider(api);
    api.registerImageGenerationProvider(createLazyGoogleImageGenerationProvider());
    api.registerMediaUnderstandingProvider(createLazyGoogleMediaUnderstandingProvider());
    api.registerMusicGenerationProvider(buildGoogleMusicGenerationProvider());
    api.registerVideoGenerationProvider(buildGoogleVideoGenerationProvider());
    api.registerWebSearchProvider(createGeminiWebSearchProvider());
  },
});
