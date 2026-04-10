import type { ModelDefinitionConfig } from "./provider-model-shared.js";

export interface VolcModelCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ModelDefinitionConfig["input"][number][];
  contextWindow: number;
  maxTokens: number;
}

export const VOLC_MODEL_KIMI_K2_5 = {
  contextWindow: 256_000,
  id: "kimi-k2-5-260127",
  input: ["text", "image"] as const,
  maxTokens: 4096,
  name: "Kimi K2.5",
  reasoning: false,
} as const;

export const VOLC_MODEL_GLM_4_7 = {
  contextWindow: 200_000,
  id: "glm-4-7-251222",
  input: ["text", "image"] as const,
  maxTokens: 4096,
  name: "GLM 4.7",
  reasoning: false,
} as const;

export const VOLC_SHARED_CODING_MODEL_CATALOG = [
  {
    contextWindow: 256_000,
    id: "ark-code-latest",
    input: ["text"] as const,
    maxTokens: 4096,
    name: "Ark Coding Plan",
    reasoning: false,
  },
  {
    contextWindow: 256_000,
    id: "doubao-seed-code",
    input: ["text"] as const,
    maxTokens: 4096,
    name: "Doubao Seed Code",
    reasoning: false,
  },
  {
    contextWindow: 200_000,
    id: "glm-4.7",
    input: ["text"] as const,
    maxTokens: 4096,
    name: "GLM 4.7 Coding",
    reasoning: false,
  },
  {
    contextWindow: 256_000,
    id: "kimi-k2-thinking",
    input: ["text"] as const,
    maxTokens: 4096,
    name: "Kimi K2 Thinking",
    reasoning: false,
  },
  {
    contextWindow: 256_000,
    id: "kimi-k2.5",
    input: ["text"] as const,
    maxTokens: 4096,
    name: "Kimi K2.5 Coding",
    reasoning: false,
  },
] as const;

export function buildVolcModelDefinition(
  entry: VolcModelCatalogEntry,
  cost: ModelDefinitionConfig["cost"],
): ModelDefinitionConfig {
  return {
    contextWindow: entry.contextWindow,
    cost,
    id: entry.id,
    input: [...entry.input],
    maxTokens: entry.maxTokens,
    name: entry.name,
    reasoning: entry.reasoning,
  };
}
