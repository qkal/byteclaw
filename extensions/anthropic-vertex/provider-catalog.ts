import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveAnthropicVertexRegion } from "./region.js";
export const ANTHROPIC_VERTEX_DEFAULT_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

function buildAnthropicVertexModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
  cost: ModelDefinitionConfig["cost"];
  maxTokens: number;
}): ModelDefinitionConfig {
  return {
    contextWindow: ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW,
    cost: params.cost,
    id: params.id,
    input: params.input,
    maxTokens: params.maxTokens,
    name: params.name,
    reasoning: params.reasoning,
  };
}

function buildAnthropicVertexCatalog(): ModelDefinitionConfig[] {
  return [
    buildAnthropicVertexModel({
      cost: { cacheRead: 0.5, cacheWrite: 6.25, input: 5, output: 25 },
      id: "claude-opus-4-6",
      input: ["text", "image"],
      maxTokens: 128_000,
      name: "Claude Opus 4.6",
      reasoning: true,
    }),
    buildAnthropicVertexModel({
      cost: { cacheRead: 0.3, cacheWrite: 3.75, input: 3, output: 15 },
      id: ANTHROPIC_VERTEX_DEFAULT_MODEL_ID,
      input: ["text", "image"],
      maxTokens: 128_000,
      name: "Claude Sonnet 4.6",
      reasoning: true,
    }),
  ];
}

export function buildAnthropicVertexProvider(params?: {
  env?: NodeJS.ProcessEnv;
}): ModelProviderConfig {
  const region = resolveAnthropicVertexRegion(params?.env);
  const baseUrl =
    normalizeLowercaseStringOrEmpty(region) === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${region}-aiplatform.googleapis.com`;

  return {
    api: "anthropic-messages",
    apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
    baseUrl,
    models: buildAnthropicVertexCatalog(),
  };
}
