import {
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
  definePluginEntry,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  SGLANG_DEFAULT_API_KEY_ENV_VAR,
  SGLANG_DEFAULT_BASE_URL,
  SGLANG_MODEL_PLACEHOLDER,
  SGLANG_PROVIDER_LABEL,
  buildSglangProvider,
} from "./api.js";

const PROVIDER_ID = "sglang";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/provider-setup");
}

export default definePluginEntry({
  description: "Bundled SGLang provider plugin",
  id: "sglang",
  name: "SGLang Provider",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      auth: [
        {
          id: "custom",
          label: SGLANG_PROVIDER_LABEL,
          hint: "Fast self-hosted OpenAI-compatible server",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: SGLANG_PROVIDER_LABEL,
              defaultBaseUrl: SGLANG_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: SGLANG_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: SGLANG_MODEL_PLACEHOLDER,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: SGLANG_PROVIDER_LABEL,
              defaultBaseUrl: SGLANG_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: SGLANG_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: SGLANG_MODEL_PLACEHOLDER,
            });
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildSglangProvider,
          });
        },
      },
      docsPath: "/providers/sglang",
      envVars: ["SGLANG_API_KEY"],
      id: PROVIDER_ID,
      label: "SGLang",
      wizard: {
        modelPicker: {
          hint: "Enter SGLang URL + API key + model",
          label: "SGLang (custom)",
          methodId: "custom",
        },
        setup: {
          choiceHint: "Fast self-hosted OpenAI-compatible server",
          choiceId: "sglang",
          choiceLabel: "SGLang",
          groupHint: "Fast self-hosted server",
          groupId: "sglang",
          groupLabel: "SGLang",
          methodId: "custom",
        },
      },
    });
  },
});
