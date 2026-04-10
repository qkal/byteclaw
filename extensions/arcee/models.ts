import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const ARCEE_BASE_URL = "https://api.arcee.ai/api/v1";

export const ARCEE_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    contextWindow: 131_072,
    cost: {
      cacheRead: 0.045,
      cacheWrite: 0.045,
      input: 0.045,
      output: 0.15,
    },
    id: "trinity-mini",
    input: ["text"],
    maxTokens: 80_000,
    name: "Trinity Mini 26B",
    reasoning: false,
  },
  {
    contextWindow: 131_072,
    cost: {
      cacheRead: 0.25,
      cacheWrite: 0.25,
      input: 0.25,
      output: 1,
    },
    id: "trinity-large-preview",
    input: ["text"],
    maxTokens: 16_384,
    name: "Trinity Large Preview",
    reasoning: false,
  },
  {
    compat: {
      supportsReasoningEffort: false,
    },
    contextWindow: 262_144,
    cost: {
      cacheRead: 0.25,
      cacheWrite: 0.25,
      input: 0.25,
      output: 0.9,
    },
    id: "trinity-large-thinking",
    input: ["text"],
    maxTokens: 80_000,
    name: "Trinity Large Thinking",
    reasoning: true,
  },
];

export function buildArceeModelDefinition(
  model: (typeof ARCEE_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    api: "openai-completions",
    contextWindow: model.contextWindow,
    cost: model.cost,
    id: model.id,
    input: model.input,
    maxTokens: model.maxTokens,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.compat ? { compat: model.compat } : {}),
  };
}
