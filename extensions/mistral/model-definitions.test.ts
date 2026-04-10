import { describe, expect, it } from "vitest";
import {
  MISTRAL_DEFAULT_CONTEXT_WINDOW,
  MISTRAL_DEFAULT_COST,
  MISTRAL_DEFAULT_MAX_TOKENS,
  MISTRAL_DEFAULT_MODEL_ID,
  buildMistralCatalogModels,
  buildMistralModelDefinition,
} from "./model-definitions.js";

describe("mistral model definitions", () => {
  it("uses current Pi pricing for the bundled default model", () => {
    expect(buildMistralModelDefinition()).toMatchObject({
      contextWindow: MISTRAL_DEFAULT_CONTEXT_WINDOW,
      cost: MISTRAL_DEFAULT_COST,
      id: MISTRAL_DEFAULT_MODEL_ID,
      maxTokens: MISTRAL_DEFAULT_MAX_TOKENS,
    });

    expect(MISTRAL_DEFAULT_COST).toEqual({
      cacheRead: 0,
      cacheWrite: 0,
      input: 0.5,
      output: 1.5,
    });
  });

  it("publishes a curated set of current Mistral catalog models", () => {
    expect(buildMistralCatalogModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contextWindow: 256_000,
          id: "codestral-latest",
          input: ["text"],
          maxTokens: 4096,
        }),
        expect.objectContaining({
          contextWindow: 128_000,
          id: "magistral-small",
          input: ["text"],
          maxTokens: 40_000,
          reasoning: true,
        }),
        expect.objectContaining({
          contextWindow: 128_000,
          id: "mistral-small-latest",
          input: ["text", "image"],
          maxTokens: 16_384,
          reasoning: true,
        }),
        expect.objectContaining({
          contextWindow: 128_000,
          id: "pixtral-large-latest",
          input: ["text", "image"],
          maxTokens: 32_768,
        }),
      ]),
    );
  });
});
