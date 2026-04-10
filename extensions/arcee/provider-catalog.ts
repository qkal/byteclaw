import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { ARCEE_BASE_URL, ARCEE_MODEL_CATALOG, buildArceeModelDefinition } from "./models.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return String(baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
}

export function isArceeOpenRouterBaseUrl(baseUrl: string | undefined): boolean {
  return normalizeBaseUrl(baseUrl) === OPENROUTER_BASE_URL;
}

export function toArceeOpenRouterModelId(modelId: string): string {
  const normalized = modelId.trim();
  if (!normalized || normalized.startsWith("arcee/")) {
    return normalized;
  }
  return `arcee/${normalized}`;
}

export function buildArceeCatalogModels(): NonNullable<ModelProviderConfig["models"]> {
  return ARCEE_MODEL_CATALOG.map(buildArceeModelDefinition);
}

export function buildArceeOpenRouterCatalogModels(): NonNullable<ModelProviderConfig["models"]> {
  return buildArceeCatalogModels().map((model) => ({
    ...model,
    id: toArceeOpenRouterModelId(model.id),
  }));
}

export function buildArceeProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: ARCEE_BASE_URL,
    models: buildArceeCatalogModels(),
  };
}

export function buildArceeOpenRouterProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: OPENROUTER_BASE_URL,
    models: buildArceeOpenRouterCatalogModels(),
  };
}
