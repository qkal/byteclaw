import {
  type OpenClawConfig,
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  buildCloudflareAiGatewayModelDefinition,
  resolveCloudflareAiGatewayBaseUrl,
} from "./models.js";

export function buildCloudflareAiGatewayConfigPatch(params: {
  accountId: string;
  gatewayId: string;
}) {
  const baseUrl = resolveCloudflareAiGatewayBaseUrl(params);
  return {
    agents: {
      defaults: {
        models: {
          [CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]: {
            alias: "Cloudflare AI Gateway",
          },
        },
      },
    },
    models: {
      providers: {
        "cloudflare-ai-gateway": {
          api: "anthropic-messages" as const,
          baseUrl,
          models: [buildCloudflareAiGatewayModelDefinition()],
        },
      },
    },
  };
}

export function applyCloudflareAiGatewayProviderConfig(
  cfg: OpenClawConfig,
  params?: { accountId?: string; gatewayId?: string },
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF] = {
    ...models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF],
    alias: models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Cloudflare AI Gateway",
  };

  const existingProvider = cfg.models?.providers?.["cloudflare-ai-gateway"] as
    | { baseUrl?: unknown }
    | undefined;
  const baseUrl =
    params?.accountId && params?.gatewayId
      ? resolveCloudflareAiGatewayBaseUrl({
          accountId: params.accountId,
          gatewayId: params.gatewayId,
        })
      : (typeof existingProvider?.baseUrl === "string"
        ? existingProvider.baseUrl
        : undefined);
  if (!baseUrl) {
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models,
        },
      },
    };
  }

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    api: "anthropic-messages",
    baseUrl,
    defaultModel: buildCloudflareAiGatewayModelDefinition(),
    providerId: "cloudflare-ai-gateway",
  });
}

export function applyCloudflareAiGatewayConfig(
  cfg: OpenClawConfig,
  params?: { accountId?: string; gatewayId?: string },
): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyCloudflareAiGatewayProviderConfig(cfg, params),
    CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  );
}
