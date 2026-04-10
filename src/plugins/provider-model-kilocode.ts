export const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
export const KILOCODE_DEFAULT_MODEL_ID = "kilo/auto";
export const KILOCODE_DEFAULT_MODEL_REF = `kilocode/${KILOCODE_DEFAULT_MODEL_ID}`;
export const KILOCODE_DEFAULT_MODEL_NAME = "Kilo Auto";

export interface KilocodeModelCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Static fallback catalog used by synchronous config surfaces and as the
 * discovery fallback when the gateway model endpoint is unavailable.
 */
export const KILOCODE_MODEL_CATALOG: KilocodeModelCatalogEntry[] = [
  {
    contextWindow: 1_000_000,
    id: KILOCODE_DEFAULT_MODEL_ID,
    input: ["text", "image"],
    maxTokens: 128_000,
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
} as const;
