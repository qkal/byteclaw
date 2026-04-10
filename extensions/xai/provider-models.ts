import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import { applyXaiModelCompat } from "openclaw/plugin-sdk/provider-tools";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { XAI_BASE_URL, resolveXaiCatalogEntry } from "./model-definitions.js";

const XAI_MODERN_MODEL_PREFIXES = ["grok-3", "grok-4", "grok-code-fast"] as const;

export function isModernXaiModel(modelId: string): boolean {
  const lower = normalizeOptionalLowercaseString(modelId) ?? "";
  if (!lower || lower.includes("multi-agent")) {
    return false;
  }
  return XAI_MODERN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function resolveXaiForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}) {
  const definition = resolveXaiCatalogEntry(params.ctx.modelId);
  if (!definition) {
    return undefined;
  }

  return applyXaiModelCompat(
    normalizeModelCompat({
      api: params.ctx.providerConfig?.api ?? "openai-responses",
      baseUrl: params.ctx.providerConfig?.baseUrl ?? XAI_BASE_URL,
      contextWindow: definition.contextWindow,
      cost: definition.cost,
      id: definition.id,
      input: definition.input,
      maxTokens: definition.maxTokens,
      name: definition.name,
      provider: params.providerId,
      reasoning: definition.reasoning,
    } as ProviderRuntimeModel),
  );
}
