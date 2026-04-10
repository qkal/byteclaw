import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { ensureModelAllowlistEntry } from "openclaw/plugin-sdk/provider-onboard";
import { BYTEPLUS_CODING_MODEL_CATALOG, BYTEPLUS_MODEL_CATALOG } from "./models.js";
import { buildBytePlusCodingProvider, buildBytePlusProvider } from "./provider-catalog.js";
import { buildBytePlusVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "byteplus";
const BYTEPLUS_DEFAULT_MODEL_REF = "byteplus-plan/ark-code-latest";

export default definePluginEntry({
  description: "Bundled BytePlus provider plugin",
  id: PROVIDER_ID,
  name: "BytePlus Provider",
  register(api) {
    api.registerProvider({
      augmentModelCatalog: () => {
        const byteplusModels = BYTEPLUS_MODEL_CATALOG.map((entry) => ({
          provider: "byteplus",
          id: entry.id,
          name: entry.name,
          reasoning: entry.reasoning,
          input: [...entry.input],
          contextWindow: entry.contextWindow,
        }));
        const byteplusPlanModels = BYTEPLUS_CODING_MODEL_CATALOG.map((entry) => ({
          provider: "byteplus-plan",
          id: entry.id,
          name: entry.name,
          reasoning: entry.reasoning,
          input: [...entry.input],
          contextWindow: entry.contextWindow,
        }));
        return [...byteplusModels, ...byteplusPlanModels];
      },
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "BytePlus API key",
          hint: "API key",
          optionKey: "byteplusApiKey",
          flagName: "--byteplus-api-key",
          envVar: "BYTEPLUS_API_KEY",
          promptMessage: "Enter BytePlus API key",
          defaultModel: BYTEPLUS_DEFAULT_MODEL_REF,
          expectedProviders: ["byteplus"],
          applyConfig: (cfg) =>
            ensureModelAllowlistEntry({
              cfg,
              modelRef: BYTEPLUS_DEFAULT_MODEL_REF,
            }),
          wizard: {
            choiceId: "byteplus-api-key",
            choiceLabel: "BytePlus API key",
            groupId: "byteplus",
            groupLabel: "BytePlus",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "paired",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            providers: {
              byteplus: { ...buildBytePlusProvider(), apiKey },
              "byteplus-plan": { ...buildBytePlusCodingProvider(), apiKey },
            },
          };
        },
      },
      docsPath: "/concepts/model-providers#byteplus-international",
      envVars: ["BYTEPLUS_API_KEY"],
      id: PROVIDER_ID,
      label: "BytePlus",
    });
    api.registerVideoGenerationProvider(buildBytePlusVideoGenerationProvider());
  },
});
