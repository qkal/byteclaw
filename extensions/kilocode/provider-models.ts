import type { KilocodeModelCatalogEntry } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const log = createSubsystemLogger("kilocode-models");

export const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
export const KILOCODE_DEFAULT_MODEL_ID = "kilo/auto";
export const KILOCODE_DEFAULT_MODEL_REF = `kilocode/${KILOCODE_DEFAULT_MODEL_ID}`;
export const KILOCODE_DEFAULT_MODEL_NAME = "Kilo Auto";

export const KILOCODE_MODEL_CATALOG: KilocodeModelCatalogEntry[] = [
  {
    id: KILOCODE_DEFAULT_MODEL_ID,
    input: ["text", "image"],
    name: KILOCODE_DEFAULT_MODEL_NAME,
    reasoning: true,
  },
];

export const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const KILOCODE_DEFAULT_MAX_TOKENS = 128_000;
export const KILOCODE_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
};

export const KILOCODE_MODELS_URL = `${KILOCODE_BASE_URL}models`;

const DISCOVERY_TIMEOUT_MS = 5000;

interface GatewayModelPricing {
  prompt: string;
  completion: string;
  image?: string;
  request?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  web_search?: string;
  internal_reasoning?: string;
}

interface GatewayModelEntry {
  id: string;
  name: string;
  context_length: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  top_provider?: {
    max_completion_tokens?: number | null;
  };
  pricing: GatewayModelPricing;
  supported_parameters?: string[];
}

interface GatewayModelsResponse {
  data: GatewayModelEntry[];
}

function toPricePerMillion(perToken: string | undefined): number {
  if (!perToken) {
    return 0;
  }
  const num = Number(perToken);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }
  return num * 1_000_000;
}

function parseModality(entry: GatewayModelEntry): ("text" | "image")[] {
  const modalities = entry.architecture?.input_modalities;
  if (!Array.isArray(modalities)) {
    return ["text"];
  }
  const hasImage = modalities.some(
    (m) => typeof m === "string" && normalizeLowercaseStringOrEmpty(m) === "image",
  );
  return hasImage ? ["text", "image"] : ["text"];
}

function parseReasoning(entry: GatewayModelEntry): boolean {
  const params = entry.supported_parameters;
  if (!Array.isArray(params)) {
    return false;
  }
  return params.includes("reasoning") || params.includes("include_reasoning");
}

function toModelDefinition(entry: GatewayModelEntry): ModelDefinitionConfig {
  return {
    contextWindow: entry.context_length || KILOCODE_DEFAULT_CONTEXT_WINDOW,
    cost: {
      cacheRead: toPricePerMillion(entry.pricing.input_cache_read),
      cacheWrite: toPricePerMillion(entry.pricing.input_cache_write),
      input: toPricePerMillion(entry.pricing.prompt),
      output: toPricePerMillion(entry.pricing.completion),
    },
    id: entry.id,
    input: parseModality(entry),
    maxTokens: entry.top_provider?.max_completion_tokens ?? KILOCODE_DEFAULT_MAX_TOKENS,
    name: entry.name || entry.id,
    reasoning: parseReasoning(entry),
  };
}

function buildStaticCatalog(): ModelDefinitionConfig[] {
  return KILOCODE_MODEL_CATALOG.map((model) => ({
    contextWindow: model.contextWindow ?? KILOCODE_DEFAULT_CONTEXT_WINDOW,
    cost: KILOCODE_DEFAULT_COST,
    id: model.id,
    input: model.input,
    maxTokens: model.maxTokens ?? KILOCODE_DEFAULT_MAX_TOKENS,
    name: model.name,
    reasoning: model.reasoning,
  }));
}

export async function discoverKilocodeModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return buildStaticCatalog();
  }

  try {
    const response = await fetch(KILOCODE_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
      return buildStaticCatalog();
    }

    const data = (await response.json()) as GatewayModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      log.warn("No models found from gateway API, using static catalog");
      return buildStaticCatalog();
    }

    const models: ModelDefinitionConfig[] = [];
    const discoveredIds = new Set<string>();

    for (const entry of data.data) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!id || discoveredIds.has(id)) {
        continue;
      }
      try {
        models.push(toModelDefinition(entry));
        discoveredIds.add(id);
      } catch (error) {
        log.warn(`Skipping malformed model entry "${id}": ${String(error)}`);
      }
    }

    const staticModels = buildStaticCatalog();
    for (const staticModel of staticModels) {
      if (!discoveredIds.has(staticModel.id)) {
        models.unshift(staticModel);
      }
    }

    return models.length > 0 ? models : buildStaticCatalog();
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return buildStaticCatalog();
  }
}

export function buildKilocodeModelDefinition(): ModelDefinitionConfig {
  return {
    contextWindow: KILOCODE_DEFAULT_CONTEXT_WINDOW,
    cost: KILOCODE_DEFAULT_COST,
    id: KILOCODE_DEFAULT_MODEL_ID,
    input: ["text", "image"],
    maxTokens: KILOCODE_DEFAULT_MAX_TOKENS,
    name: KILOCODE_DEFAULT_MODEL_NAME,
    reasoning: true,
  };
}
