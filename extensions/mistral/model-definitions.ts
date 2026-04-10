import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
export const MISTRAL_DEFAULT_MODEL_ID = "mistral-large-latest";
export const MISTRAL_DEFAULT_MODEL_REF = `mistral/${MISTRAL_DEFAULT_MODEL_ID}`;
export const MISTRAL_DEFAULT_CONTEXT_WINDOW = 262_144;
export const MISTRAL_DEFAULT_MAX_TOKENS = 16_384;
export const MISTRAL_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0.5,
  output: 1.5,
};

const MISTRAL_MODEL_CATALOG = [
  {
    contextWindow: 256_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 0.9 },
    id: "codestral-latest",
    input: ["text"],
    maxTokens: 4096,
    name: "Codestral (latest)",
    reasoning: false,
  },
  {
    contextWindow: 262_144,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.4, output: 2 },
    id: "devstral-medium-latest",
    input: ["text"],
    maxTokens: 32_768,
    name: "Devstral 2 (latest)",
    reasoning: false,
  },
  {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.5, output: 1.5 },
    id: "magistral-small",
    input: ["text"],
    maxTokens: 40_000,
    name: "Magistral Small",
    reasoning: true,
  },
  {
    contextWindow: MISTRAL_DEFAULT_CONTEXT_WINDOW,
    cost: MISTRAL_DEFAULT_COST,
    id: "mistral-large-latest",
    input: ["text", "image"],
    maxTokens: MISTRAL_DEFAULT_MAX_TOKENS,
    name: "Mistral Large (latest)",
    reasoning: false,
  },
  {
    contextWindow: 262_144,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.4, output: 2 },
    id: "mistral-medium-2508",
    input: ["text", "image"],
    maxTokens: 8192,
    name: "Mistral Medium 3.1",
    reasoning: false,
  },
  {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.1, output: 0.3 },
    id: "mistral-small-latest",
    input: ["text", "image"],
    maxTokens: 16_384,
    name: "Mistral Small (latest)",
    reasoning: true,
  },
  {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 2, output: 6 },
    id: "pixtral-large-latest",
    input: ["text", "image"],
    maxTokens: 32_768,
    name: "Pixtral Large (latest)",
    reasoning: false,
  },
] as const satisfies readonly ModelDefinitionConfig[];

export function buildMistralModelDefinition(): ModelDefinitionConfig {
  return (
    MISTRAL_MODEL_CATALOG.find((model) => model.id === MISTRAL_DEFAULT_MODEL_ID) ?? {
      contextWindow: MISTRAL_DEFAULT_CONTEXT_WINDOW,
      cost: MISTRAL_DEFAULT_COST,
      id: MISTRAL_DEFAULT_MODEL_ID,
      input: ["text", "image"],
      maxTokens: MISTRAL_DEFAULT_MAX_TOKENS,
      name: "Mistral Large",
      reasoning: false,
    }
  );
}

export function buildMistralCatalogModels(): ModelDefinitionConfig[] {
  return MISTRAL_MODEL_CATALOG.map((model) => ({ ...model, input: [...model.input] }));
}
