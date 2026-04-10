import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

export const XAI_BASE_URL = "https://api.x.ai/v1";
export const XAI_DEFAULT_MODEL_ID = "grok-4";
export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
export const XAI_DEFAULT_CONTEXT_WINDOW = 256_000;
export const XAI_LARGE_CONTEXT_WINDOW = 2_000_000;
export const XAI_CODE_CONTEXT_WINDOW = 256_000;
export const XAI_DEFAULT_MAX_TOKENS = 64_000;
export const XAI_LEGACY_CONTEXT_WINDOW = 131_072;
export const XAI_LEGACY_MAX_TOKENS = 8192;

type XaiCost = ModelDefinitionConfig["cost"];

interface XaiCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input?: ModelDefinitionConfig["input"];
  contextWindow: number;
  maxTokens?: number;
  cost: XaiCost;
}

const XAI_GROK_4_COST = {
  cacheRead: 0.75,
  cacheWrite: 0,
  input: 3,
  output: 15,
} satisfies XaiCost;

const XAI_FAST_COST = {
  cacheRead: 0.05,
  cacheWrite: 0,
  input: 0.2,
  output: 0.5,
} satisfies XaiCost;

const XAI_GROK_420_COST = {
  cacheRead: 0.2,
  cacheWrite: 0,
  input: 2,
  output: 6,
} satisfies XaiCost;

const XAI_CODE_FAST_COST = {
  cacheRead: 0.02,
  cacheWrite: 0,
  input: 0.2,
  output: 1.5,
} satisfies XaiCost;

const XAI_MODEL_CATALOG = [
  {
    contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
    cost: XAI_GROK_4_COST,
    id: "grok-3",
    input: ["text"],
    maxTokens: XAI_LEGACY_MAX_TOKENS,
    name: "Grok 3",
    reasoning: false,
  },
  {
    contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
    cost: { cacheRead: 1.25, cacheWrite: 0, input: 5, output: 25 },
    id: "grok-3-fast",
    input: ["text"],
    maxTokens: XAI_LEGACY_MAX_TOKENS,
    name: "Grok 3 Fast",
    reasoning: false,
  },
  {
    contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
    cost: { cacheRead: 0.075, cacheWrite: 0, input: 0.3, output: 0.5 },
    id: "grok-3-mini",
    input: ["text"],
    maxTokens: XAI_LEGACY_MAX_TOKENS,
    name: "Grok 3 Mini",
    reasoning: true,
  },
  {
    contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
    cost: { cacheRead: 0.15, cacheWrite: 0, input: 0.6, output: 4 },
    id: "grok-3-mini-fast",
    input: ["text"],
    maxTokens: XAI_LEGACY_MAX_TOKENS,
    name: "Grok 3 Mini Fast",
    reasoning: true,
  },
  {
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    cost: XAI_GROK_4_COST,
    id: "grok-4",
    input: ["text"],
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    name: "Grok 4",
    reasoning: true,
  },
  {
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    cost: XAI_GROK_4_COST,
    id: "grok-4-0709",
    input: ["text"],
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    name: "Grok 4 0709",
    reasoning: false,
  },
  {
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    cost: XAI_FAST_COST,
    id: "grok-4-fast",
    input: ["text", "image"],
    maxTokens: 30_000,
    name: "Grok 4 Fast",
    reasoning: true,
  },
  {
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    cost: XAI_FAST_COST,
    id: "grok-4-fast-non-reasoning",
    input: ["text", "image"],
    maxTokens: 30_000,
    name: "Grok 4 Fast (Non-Reasoning)",
    reasoning: false,
  },
  {
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    cost: XAI_FAST_COST,
    id: "grok-4-1-fast",
    input: ["text", "image"],
    maxTokens: 30_000,
    name: "Grok 4.1 Fast",
    reasoning: true,
  },
  {
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    cost: XAI_FAST_COST,
    id: "grok-4-1-fast-non-reasoning",
    input: ["text", "image"],
    maxTokens: 30_000,
    name: "Grok 4.1 Fast (Non-Reasoning)",
    reasoning: false,
  },
  {
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    cost: XAI_GROK_420_COST,
    id: "grok-4.20-beta-latest-reasoning",
    input: ["text", "image"],
    maxTokens: 30_000,
    name: "Grok 4.20 Beta Latest (Reasoning)",
    reasoning: true,
  },
  {
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    cost: XAI_GROK_420_COST,
    id: "grok-4.20-beta-latest-non-reasoning",
    input: ["text", "image"],
    maxTokens: 30_000,
    name: "Grok 4.20 Beta Latest (Non-Reasoning)",
    reasoning: false,
  },
  {
    contextWindow: XAI_CODE_CONTEXT_WINDOW,
    cost: XAI_CODE_FAST_COST,
    id: "grok-code-fast-1",
    input: ["text"],
    maxTokens: 10_000,
    name: "Grok Code Fast 1",
    reasoning: true,
  },
] as const satisfies readonly XaiCatalogEntry[];

function toModelDefinition(entry: XaiCatalogEntry): ModelDefinitionConfig {
  return {
    contextWindow: entry.contextWindow,
    cost: entry.cost,
    id: entry.id,
    input: entry.input ?? ["text"],
    maxTokens: entry.maxTokens ?? XAI_DEFAULT_MAX_TOKENS,
    name: entry.name,
    reasoning: entry.reasoning,
  };
}

export function buildXaiModelDefinition(): ModelDefinitionConfig {
  return toModelDefinition(
    XAI_MODEL_CATALOG.find((entry) => entry.id === XAI_DEFAULT_MODEL_ID) ?? {
      contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
      cost: XAI_GROK_4_COST,
      id: XAI_DEFAULT_MODEL_ID,
      input: ["text"],
      maxTokens: XAI_DEFAULT_MAX_TOKENS,
      name: "Grok 4",
      reasoning: false,
    },
  );
}

export function buildXaiCatalogModels(): ModelDefinitionConfig[] {
  return XAI_MODEL_CATALOG.map((entry) => toModelDefinition(entry));
}

export function resolveXaiCatalogEntry(modelId: string) {
  const trimmed = modelId.trim();
  const lower = normalizeOptionalLowercaseString(modelId) ?? "";
  const exact = XAI_MODEL_CATALOG.find(
    (entry) => normalizeOptionalLowercaseString(entry.id) === lower,
  );
  if (exact) {
    return toModelDefinition(exact);
  }
  if (lower.includes("multi-agent")) {
    return undefined;
  }
  if (lower.startsWith("grok-code-fast")) {
    return toModelDefinition({
      contextWindow: XAI_CODE_CONTEXT_WINDOW,
      cost: XAI_CODE_FAST_COST,
      id: trimmed,
      input: ["text"],
      maxTokens: 10_000,
      name: trimmed,
      reasoning: true,
    });
  }
  if (
    lower.startsWith("grok-3-mini-fast") ||
    lower.startsWith("grok-3-mini") ||
    lower.startsWith("grok-3-fast") ||
    lower.startsWith("grok-3")
  ) {
    const legacyCost = lower.startsWith("grok-3-mini-fast")
      ? { cacheRead: 0.15, cacheWrite: 0, input: 0.6, output: 4 }
      : lower.startsWith("grok-3-mini")
        ? { cacheRead: 0.075, cacheWrite: 0, input: 0.3, output: 0.5 }
        : lower.startsWith("grok-3-fast")
          ? { cacheRead: 1.25, cacheWrite: 0, input: 5, output: 25 }
          : XAI_GROK_4_COST;
    return toModelDefinition({
      contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
      cost: legacyCost,
      id: trimmed,
      input: ["text"],
      maxTokens: XAI_LEGACY_MAX_TOKENS,
      name: trimmed,
      reasoning: lower.includes("mini"),
    });
  }
  if (
    lower.startsWith("grok-4.20") ||
    lower.startsWith("grok-4-1") ||
    lower.startsWith("grok-4-fast")
  ) {
    return toModelDefinition({
      contextWindow: XAI_LARGE_CONTEXT_WINDOW,
      cost: lower.startsWith("grok-4.20") ? XAI_GROK_420_COST : XAI_FAST_COST,
      id: trimmed,
      input: ["text", "image"],
      maxTokens: 30_000,
      name: trimmed,
      reasoning: !lower.includes("non-reasoning"),
    });
  }
  if (lower.startsWith("grok-4")) {
    return toModelDefinition({
      contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
      cost: XAI_GROK_4_COST,
      id: modelId.trim(),
      input: ["text"],
      maxTokens: XAI_DEFAULT_MAX_TOKENS,
      name: modelId.trim(),
      reasoning: lower.includes("reasoning"),
    });
  }
  return undefined;
}
