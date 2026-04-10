import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  VOLC_MODEL_GLM_4_7,
  VOLC_MODEL_KIMI_K2_5,
  VOLC_SHARED_CODING_MODEL_CATALOG,
  buildVolcModelDefinition,
} from "openclaw/plugin-sdk/volc-model-catalog-shared";

export const BYTEPLUS_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
export const BYTEPLUS_CODING_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/coding/v3";
export const BYTEPLUS_DEFAULT_MODEL_ID = "seed-1-8-251228";
export const BYTEPLUS_CODING_DEFAULT_MODEL_ID = "ark-code-latest";
export const BYTEPLUS_DEFAULT_MODEL_REF = `byteplus/${BYTEPLUS_DEFAULT_MODEL_ID}`;

export const BYTEPLUS_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0.0001,
  output: 0.0002,
};

export const BYTEPLUS_MODEL_CATALOG = [
  {
    contextWindow: 256_000,
    id: "seed-1-8-251228",
    input: ["text", "image"] as const,
    maxTokens: 4096,
    name: "Seed 1.8",
    reasoning: false,
  },
  VOLC_MODEL_KIMI_K2_5,
  VOLC_MODEL_GLM_4_7,
] as const;

export const BYTEPLUS_CODING_MODEL_CATALOG = VOLC_SHARED_CODING_MODEL_CATALOG;

export type BytePlusCatalogEntry = (typeof BYTEPLUS_MODEL_CATALOG)[number];
export type BytePlusCodingCatalogEntry = (typeof BYTEPLUS_CODING_MODEL_CATALOG)[number];

export function buildBytePlusModelDefinition(
  entry: BytePlusCatalogEntry | BytePlusCodingCatalogEntry,
): ModelDefinitionConfig {
  return buildVolcModelDefinition(entry, BYTEPLUS_DEFAULT_COST);
}
