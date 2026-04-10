import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildFalImageGenerationProvider } from "./image-generation-provider.js";
import { FAL_DEFAULT_IMAGE_MODEL_REF, applyFalConfig } from "./onboard.js";
import { buildFalVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "fal";

export default definePluginEntry({
  description: "Bundled fal image generation provider",
  id: PROVIDER_ID,
  name: "fal Provider",
  register(api) {
    api.registerProvider({
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "fal API key",
          hint: "Image generation API key",
          optionKey: "falApiKey",
          flagName: "--fal-api-key",
          envVar: "FAL_KEY",
          promptMessage: "Enter fal API key",
          defaultModel: FAL_DEFAULT_IMAGE_MODEL_REF,
          expectedProviders: ["fal"],
          applyConfig: (cfg) => applyFalConfig(cfg),
          wizard: {
            choiceId: "fal-api-key",
            choiceLabel: "fal API key",
            choiceHint: "Image generation API key",
            groupId: "fal",
            groupLabel: "fal",
            groupHint: "Image generation",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
      docsPath: "/providers/models",
      envVars: ["FAL_KEY"],
      id: PROVIDER_ID,
      label: "fal",
    });
    api.registerImageGenerationProvider(buildFalImageGenerationProvider());
    api.registerVideoGenerationProvider(buildFalVideoGenerationProvider());
  },
});
