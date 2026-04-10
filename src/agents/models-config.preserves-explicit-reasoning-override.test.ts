import { describe, expect, it } from "vitest";
import { mergeProviderModels, mergeProviders } from "./models-config.merge.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

const MINIMAX_MODEL_ID = "MiniMax-M2.7";

function createMinimaxProvider(model: NonNullable<ProviderConfig["models"]>[number]) {
  return {
    api: "anthropic-messages",
    baseUrl: "https://api.minimax.io/anthropic",
    models: [model],
  } satisfies ProviderConfig;
}

function createMinimaxModel(
  overrides: Partial<NonNullable<ProviderConfig["models"]>[number]> = {},
): NonNullable<ProviderConfig["models"]>[number] {
  return {
    contextWindow: 1_000_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: MINIMAX_MODEL_ID,
    input: ["text"],
    maxTokens: 8192,
    name: "MiniMax M2.7",
    ...overrides,
  } as NonNullable<ProviderConfig["models"]>[number];
}

function createMinimaxModelWithoutReasoning(): NonNullable<ProviderConfig["models"]>[number] {
  return {
    contextWindow: 1_000_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: MINIMAX_MODEL_ID,
    input: ["text"],
    maxTokens: 8192,
    name: "MiniMax M2.7",
  } as NonNullable<ProviderConfig["models"]>[number];
}

function mergedMinimaxModel(
  explicitModel: NonNullable<ProviderConfig["models"]>[number],
): NonNullable<ProviderConfig["models"]>[number] | undefined {
  return mergeProviderModels(
    createMinimaxProvider(createMinimaxModel({ reasoning: true })),
    createMinimaxProvider(explicitModel),
  ).models?.find((model) => model.id === MINIMAX_MODEL_ID);
}

describe("models-config: explicit reasoning override", () => {
  it("preserves user reasoning:false when the built-in catalog has reasoning:true", () => {
    const merged = mergedMinimaxModel(createMinimaxModel({ reasoning: false }));

    expect(merged).toBeDefined();
    expect(merged?.reasoning).toBe(false);
  });

  it("keeps reasoning unset when user omits the field", () => {
    const merged = mergeProviders({
      explicit: {
        minimax: createMinimaxProvider(createMinimaxModelWithoutReasoning()),
      },
      implicit: {},
    }).minimax?.models?.find((model) => model.id === MINIMAX_MODEL_ID);

    expect(merged).toBeDefined();
    expect(merged?.reasoning).toBeUndefined();
  });
});
