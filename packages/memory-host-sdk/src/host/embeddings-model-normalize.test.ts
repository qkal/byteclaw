import { describe, expect, it } from "vitest";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";

describe("normalizeEmbeddingModelWithPrefixes", () => {
  it("returns default model when input is blank", () => {
    expect(
      normalizeEmbeddingModelWithPrefixes({
        defaultModel: "fallback-model",
        model: "   ",
        prefixes: ["openai/"],
      }),
    ).toBe("fallback-model");
  });

  it("strips the first matching prefix", () => {
    expect(
      normalizeEmbeddingModelWithPrefixes({
        defaultModel: "fallback-model",
        model: "openai/text-embedding-3-small",
        prefixes: ["openai/"],
      }),
    ).toBe("text-embedding-3-small");
  });

  it("keeps explicit model names when no prefix matches", () => {
    expect(
      normalizeEmbeddingModelWithPrefixes({
        defaultModel: "fallback-model",
        model: "voyage-4-large",
        prefixes: ["voyage/"],
      }),
    ).toBe("voyage-4-large");
  });
});
