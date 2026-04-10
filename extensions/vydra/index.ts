import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildVydraImageGenerationProvider } from "./image-generation-provider.js";
import { VYDRA_DEFAULT_IMAGE_MODEL_REF, applyVydraConfig } from "./onboard.js";
import { buildVydraSpeechProvider } from "./speech-provider.js";
import { buildVydraVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "vydra";

export default definePluginEntry({
  description: "Bundled Vydra image, video, and speech provider",
  id: PROVIDER_ID,
  name: "Vydra Provider",
  register(api) {
    api.registerProvider({
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Vydra API key",
          hint: "Image, video, and speech API key",
          optionKey: "vydraApiKey",
          flagName: "--vydra-api-key",
          envVar: "VYDRA_API_KEY",
          promptMessage: "Enter Vydra API key",
          defaultModel: VYDRA_DEFAULT_IMAGE_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyVydraConfig(cfg),
          wizard: {
            choiceId: "vydra-api-key",
            choiceLabel: "Vydra API key",
            choiceHint: "Image, video, and speech API key",
            groupId: "vydra",
            groupLabel: "Vydra",
            groupHint: "Image, video, and speech",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
      docsPath: "/providers/vydra",
      envVars: ["VYDRA_API_KEY"],
      id: PROVIDER_ID,
      label: "Vydra",
    });
    api.registerSpeechProvider(buildVydraSpeechProvider());
    api.registerImageGenerationProvider(buildVydraImageGenerationProvider());
    api.registerVideoGenerationProvider(buildVydraVideoGenerationProvider());
  },
});
