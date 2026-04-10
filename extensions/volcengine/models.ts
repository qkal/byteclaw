import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  VOLC_MODEL_GLM_4_7,
  VOLC_MODEL_KIMI_K2_5,
  VOLC_SHARED_CODING_MODEL_CATALOG,
  buildVolcModelDefinition,
} from "openclaw/plugin-sdk/volc-model-catalog-shared";

export const DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DOUBAO_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
export const DOUBAO_DEFAULT_MODEL_ID = "doubao-seed-1-8-251228";
export const DOUBAO_CODING_DEFAULT_MODEL_ID = "ark-code-latest";
export const DOUBAO_DEFAULT_MODEL_REF = `volcengine/${DOUBAO_DEFAULT_MODEL_ID}`;

export const DOUBAO_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0.0001,
  output: 0.0002,
};

export const DOUBAO_MODEL_CATALOG = [
  {
    contextWindow: 256_000,
    id: "doubao-seed-code-preview-251028",
    input: ["text", "image"] as const,
    maxTokens: 4096,
    name: "doubao-seed-code-preview-251028",
    reasoning: false,
  },
  {
    contextWindow: 256_000,
    id: "doubao-seed-1-8-251228",
    input: ["text", "image"] as const,
    maxTokens: 4096,
    name: "Doubao Seed 1.8",
    reasoning: false,
  },
  VOLC_MODEL_KIMI_K2_5,
  VOLC_MODEL_GLM_4_7,
  {
    contextWindow: 128_000,
    id: "deepseek-v3-2-251201",
    input: ["text", "image"] as const,
    maxTokens: 4096,
    name: "DeepSeek V3.2",
    reasoning: false,
  },
] as const;

export const DOUBAO_CODING_MODEL_CATALOG = [
  ...VOLC_SHARED_CODING_MODEL_CATALOG,
  {
    contextWindow: 256_000,
    id: "doubao-seed-code-preview-251028",
    input: ["text"] as const,
    maxTokens: 4096,
    name: "Doubao Seed Code Preview",
    reasoning: false,
  },
] as const;

export type DoubaoCatalogEntry = (typeof DOUBAO_MODEL_CATALOG)[number];
export type DoubaoCodingCatalogEntry = (typeof DOUBAO_CODING_MODEL_CATALOG)[number];

export function buildDoubaoModelDefinition(
  entry: DoubaoCatalogEntry | DoubaoCodingCatalogEntry,
): ModelDefinitionConfig {
  return buildVolcModelDefinition(entry, DOUBAO_DEFAULT_COST);
}
