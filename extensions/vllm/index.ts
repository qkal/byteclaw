import {
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
  definePluginEntry,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  VLLM_DEFAULT_API_KEY_ENV_VAR,
  VLLM_DEFAULT_BASE_URL,
  VLLM_MODEL_PLACEHOLDER,
  VLLM_PROVIDER_LABEL,
  buildVllmProvider,
} from "./api.js";

const PROVIDER_ID = "vllm";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/provider-setup");
}

export default definePluginEntry({
  description: "Bundled vLLM provider plugin",
  id: "vllm",
  name: "vLLM Provider",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      auth: [
        {
          id: "custom",
          label: VLLM_PROVIDER_LABEL,
          hint: "Local/self-hosted OpenAI-compatible server",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: VLLM_PROVIDER_LABEL,
              defaultBaseUrl: VLLM_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: VLLM_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: VLLM_MODEL_PLACEHOLDER,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: VLLM_PROVIDER_LABEL,
              defaultBaseUrl: VLLM_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: VLLM_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: VLLM_MODEL_PLACEHOLDER,
            });
          },
        },
      ],
      buildUnknownModelHint: () =>
        "vLLM requires authentication to be registered as a provider. " +
        'Set VLLM_API_KEY (any value works) or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/vllm",
      discovery: {
        order: "late",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildVllmProvider,
          });
        },
      },
      docsPath: "/providers/vllm",
      envVars: ["VLLM_API_KEY"],
      id: PROVIDER_ID,
      label: "vLLM",
      wizard: {
        modelPicker: {
          hint: "Enter vLLM URL + API key + model",
          label: "vLLM (custom)",
          methodId: "custom",
        },
        setup: {
          choiceHint: "Local/self-hosted OpenAI-compatible server",
          choiceId: "vllm",
          choiceLabel: "vLLM",
          groupHint: "Local/self-hosted OpenAI-compatible",
          groupId: "vllm",
          groupLabel: "vLLM",
          methodId: "custom",
        },
      },
    });
  },
});
