import { describe, expect, it } from "vitest";
import {
  resolveModelDisplayName,
  resolveModelDisplayRef,
  resolveSessionInfoModelSelection,
} from "./model-selection-display.js";

describe("model-selection-display", () => {
  describe("resolveModelDisplayRef", () => {
    it("keeps explicit runtime slash-bearing ids unchanged for display", () => {
      expect(
        resolveModelDisplayRef({
          runtimeModel: "anthropic/claude-haiku-4.5",
        }),
      ).toBe("anthropic/claude-haiku-4.5");
    });

    it("combines separate runtime provider and model ids", () => {
      expect(
        resolveModelDisplayRef({
          runtimeModel: "gpt-5.4",
          runtimeProvider: "openai",
        }),
      ).toBe("openai/gpt-5.4");
    });

    it("falls back to override values when runtime values are absent", () => {
      expect(
        resolveModelDisplayRef({
          overrideModel: "anthropic/claude-sonnet-4-6",
          overrideProvider: "openrouter",
        }),
      ).toBe("anthropic/claude-sonnet-4-6");
    });
  });

  describe("resolveModelDisplayName", () => {
    it("renders the trailing model segment for compact UI labels", () => {
      expect(
        resolveModelDisplayName({
          runtimeModel: "anthropic/claude-sonnet-4-6",
          runtimeProvider: "openrouter",
        }),
      ).toBe("claude-sonnet-4-6");
    });

    it("returns a stable empty-state label", () => {
      expect(resolveModelDisplayName({})).toBe("model n/a");
    });
  });

  describe("resolveSessionInfoModelSelection", () => {
    it("keeps partial runtime patches merged with current state", () => {
      expect(
        resolveSessionInfoModelSelection({
          currentModel: "claude-sonnet-4-6",
          currentProvider: "anthropic",
          entryModel: "claude-opus-4-6",
        }),
      ).toEqual({
        model: "claude-opus-4-6",
        modelProvider: "anthropic",
      });
    });

    it("keeps override ids attached to the current provider when no override provider is stored", () => {
      expect(
        resolveSessionInfoModelSelection({
          currentModel: "claude-sonnet-4-6",
          currentProvider: "anthropic",
          overrideModel: "ollama-beelink2/qwen2.5-coder:7b",
        }),
      ).toEqual({
        model: "ollama-beelink2/qwen2.5-coder:7b",
        modelProvider: "anthropic",
      });
    });

    it("keeps the current provider for slash-bearing override ids when provider is already known", () => {
      expect(
        resolveSessionInfoModelSelection({
          currentModel: "openrouter/auto",
          currentProvider: "openrouter",
          overrideModel: "anthropic/claude-haiku-4.5",
        }),
      ).toEqual({
        model: "anthropic/claude-haiku-4.5",
        modelProvider: "openrouter",
      });
    });
  });
});
