import type { ProviderNormalizeResolvedModelContext } from "openclaw/plugin-sdk/core";
import type {
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { apiKeyAuthMethod, entraIdAuthMethod } from "./auth.js";
import { prepareFoundryRuntimeAuth } from "./runtime.js";
import {
  PROVIDER_ID,
  applyFoundryProfileBinding,
  applyFoundryProviderConfig,
  buildFoundryProviderBaseUrl,
  extractFoundryEndpoint,
  isFoundryProviderApi,
  normalizeFoundryEndpoint,
  resolveFoundryModelCapabilities,
  resolveFoundryTargetProfileId,
} from "./shared.js";

export function buildMicrosoftFoundryProvider(): ProviderPlugin {
  return {
    auth: [entraIdAuthMethod, apiKeyAuthMethod],
    docsPath: "/providers/models",
    envVars: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
    id: PROVIDER_ID,
    label: "Microsoft Foundry",
    normalizeResolvedModel: ({ modelId, model }: ProviderNormalizeResolvedModelContext) => {
      const endpoint = extractFoundryEndpoint(String(model.baseUrl ?? ""));
      if (!endpoint) {
        return model;
      }
      const capabilities = resolveFoundryModelCapabilities(
        modelId,
        model.name,
        isFoundryProviderApi(model.api) ? model.api : undefined,
        model.input,
      );
      return {
        ...model,
        api: capabilities.api,
        baseUrl: buildFoundryProviderBaseUrl(
          endpoint,
          modelId,
          capabilities.modelName,
          capabilities.api,
        ),
        input: capabilities.input,
        name: capabilities.modelName,
        ...(capabilities.compat ? { compat: capabilities.compat } : {}),
      };
    },
    onModelSelected: async (ctx) => {
      const providerConfig = ctx.config.models?.providers?.[PROVIDER_ID];
      if (!providerConfig || !ctx.model.startsWith(`${PROVIDER_ID}/`)) {
        return;
      }
      const selectedModelId = ctx.model.slice(`${PROVIDER_ID}/`.length);
      const existingModel = providerConfig.models.find(
        (model: { id: string }) => model.id === selectedModelId,
      );
      const selectedModelCapabilities = resolveFoundryModelCapabilities(
        selectedModelId,
        existingModel?.name,
        isFoundryProviderApi(existingModel?.api) ? existingModel.api : providerConfig.api,
        existingModel?.input,
      );
      const providerEndpoint = normalizeFoundryEndpoint(providerConfig.baseUrl ?? "");
      // Prefer the persisted per-model API choice from onboarding/discovery so arbitrary
      // Deployment aliases (for example prod-primary) do not fall back to name heuristics.
      const selectedModelApi = isFoundryProviderApi(existingModel?.api)
        ? existingModel.api
        : providerConfig.api;
      const nextModels = providerConfig.models.map((model) =>
        model.id === selectedModelId
          ? {
              ...model,
              api: selectedModelCapabilities.api,
              input: selectedModelCapabilities.input,
              name: selectedModelCapabilities.modelName,
              ...(selectedModelCapabilities.compat
                ? { compat: selectedModelCapabilities.compat }
                : {}),
            }
          : model,
      );
      if (!nextModels.some((model) => model.id === selectedModelId)) {
        nextModels.push({
          api: selectedModelCapabilities.api,
          contextWindow: 128_000,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
          id: selectedModelId,
          input: selectedModelCapabilities.input,
          maxTokens: 16_384,
          name: selectedModelCapabilities.modelName,
          reasoning: false,
          ...(selectedModelCapabilities.compat ? { compat: selectedModelCapabilities.compat } : {}),
        });
      }
      const nextProviderConfig: ModelProviderConfig = {
        ...providerConfig,
        api: selectedModelCapabilities.api,
        baseUrl: buildFoundryProviderBaseUrl(
          providerEndpoint,
          selectedModelId,
          selectedModelCapabilities.modelName,
          selectedModelApi,
        ),
        models: nextModels,
      };
      const targetProfileId = resolveFoundryTargetProfileId(ctx.config);
      if (targetProfileId) {
        applyFoundryProfileBinding(ctx.config, targetProfileId);
      }
      applyFoundryProviderConfig(ctx.config, nextProviderConfig);
    },
    prepareRuntimeAuth: prepareFoundryRuntimeAuth,
  };
}
