import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
export const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_CN_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const ZAI_DEFAULT_MODEL_ID = "glm-5.1";
export const ZAI_DEFAULT_MODEL_REF = `zai/${ZAI_DEFAULT_MODEL_ID}`;

interface ZaiCatalogEntry {
  name: string;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
  contextWindow: number;
  maxTokens: number;
  cost: ModelDefinitionConfig["cost"];
}

export const ZAI_DEFAULT_COST = {
  cacheRead: 0.2,
  cacheWrite: 0,
  input: 1,
  output: 3.2,
} satisfies ModelDefinitionConfig["cost"];

const ZAI_MODEL_CATALOG = {
  "glm-4.5": {
    contextWindow: 131_072,
    cost: { cacheRead: 0.11, cacheWrite: 0, input: 0.6, output: 2.2 },
    input: ["text"],
    maxTokens: 98_304,
    name: "GLM-4.5",
    reasoning: true,
  },
  "glm-4.5-air": {
    contextWindow: 131_072,
    cost: { cacheRead: 0.03, cacheWrite: 0, input: 0.2, output: 1.1 },
    input: ["text"],
    maxTokens: 98_304,
    name: "GLM-4.5 Air",
    reasoning: true,
  },
  "glm-4.5-flash": {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    input: ["text"],
    maxTokens: 98_304,
    name: "GLM-4.5 Flash",
    reasoning: true,
  },
  "glm-4.5v": {
    contextWindow: 64_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.6, output: 1.8 },
    input: ["text", "image"],
    maxTokens: 16_384,
    name: "GLM-4.5V",
    reasoning: true,
  },
  "glm-4.6": {
    contextWindow: 204_800,
    cost: { cacheRead: 0.11, cacheWrite: 0, input: 0.6, output: 2.2 },
    input: ["text"],
    maxTokens: 131_072,
    name: "GLM-4.6",
    reasoning: true,
  },
  "glm-4.6v": {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 0.9 },
    input: ["text", "image"],
    maxTokens: 32_768,
    name: "GLM-4.6V",
    reasoning: true,
  },
  "glm-4.7": {
    contextWindow: 204_800,
    cost: { cacheRead: 0.11, cacheWrite: 0, input: 0.6, output: 2.2 },
    input: ["text"],
    maxTokens: 131_072,
    name: "GLM-4.7",
    reasoning: true,
  },
  "glm-4.7-flash": {
    contextWindow: 200_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.07, output: 0.4 },
    input: ["text"],
    maxTokens: 131_072,
    name: "GLM-4.7 Flash",
    reasoning: true,
  },
  "glm-4.7-flashx": {
    contextWindow: 200_000,
    cost: { cacheRead: 0.01, cacheWrite: 0, input: 0.06, output: 0.4 },
    input: ["text"],
    maxTokens: 128_000,
    name: "GLM-4.7 FlashX",
    reasoning: true,
  },
  "glm-5": {
    contextWindow: 202_800,
    cost: ZAI_DEFAULT_COST,
    input: ["text"],
    maxTokens: 131_100,
    name: "GLM-5",
    reasoning: true,
  },
  "glm-5-turbo": {
    contextWindow: 202_800,
    cost: { cacheRead: 0.24, cacheWrite: 0, input: 1.2, output: 4 },
    input: ["text"],
    maxTokens: 131_100,
    name: "GLM-5 Turbo",
    reasoning: true,
  },
  "glm-5.1": {
    contextWindow: 202_800,
    cost: { cacheRead: 0.24, cacheWrite: 0, input: 1.2, output: 4 },
    input: ["text"],
    maxTokens: 131_100,
    name: "GLM-5.1",
    reasoning: true,
  },
  "glm-5v-turbo": {
    contextWindow: 202_800,
    cost: { cacheRead: 0.24, cacheWrite: 0, input: 1.2, output: 4 },
    input: ["text", "image"],
    maxTokens: 131_100,
    name: "GLM-5V Turbo",
    reasoning: true,
  },
} as const satisfies Record<string, ZaiCatalogEntry>;

type ZaiCatalogId = keyof typeof ZAI_MODEL_CATALOG;

export function resolveZaiBaseUrl(endpoint?: string): string {
  switch (endpoint) {
    case "coding-cn": {
      return ZAI_CODING_CN_BASE_URL;
    }
    case "global": {
      return ZAI_GLOBAL_BASE_URL;
    }
    case "cn": {
      return ZAI_CN_BASE_URL;
    }
    case "coding-global": {
      return ZAI_CODING_GLOBAL_BASE_URL;
    }
    default: {
      return ZAI_GLOBAL_BASE_URL;
    }
  }
}

export function buildZaiModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ModelDefinitionConfig["input"];
  cost?: ModelDefinitionConfig["cost"];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = ZAI_MODEL_CATALOG[params.id as ZaiCatalogId];
  return {
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 202_800,
    cost: params.cost ?? catalog?.cost ?? ZAI_DEFAULT_COST,
    id: params.id,
    input:
      params.input ?? (catalog?.input ? ([...catalog.input] as ("text" | "image")[]) : ["text"]),
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 131_100,
    name: params.name ?? catalog?.name ?? `GLM ${params.id}`,
    reasoning: params.reasoning ?? catalog?.reasoning ?? true,
  };
}
