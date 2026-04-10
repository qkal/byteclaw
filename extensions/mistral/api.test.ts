import { describe, expect, it } from "vitest";
import {
  MISTRAL_MODEL_TRANSPORT_PATCH,
  MISTRAL_SMALL_LATEST_ID,
  applyMistralModelCompat,
  resolveMistralCompatPatch,
} from "./api.js";
import { contributeMistralResolvedModelCompat } from "./provider-compat.js";

function readCompat<T>(model: unknown): T | undefined {
  return (model as { compat?: T }).compat;
}

function supportsStore(model: unknown): boolean | undefined {
  return readCompat<{ supportsStore?: boolean }>(model)?.supportsStore;
}

function supportsReasoningEffort(model: unknown): boolean | undefined {
  return readCompat<{ supportsReasoningEffort?: boolean }>(model)?.supportsReasoningEffort;
}

function maxTokensField(model: unknown): "max_completion_tokens" | "max_tokens" | undefined {
  return readCompat<{ maxTokensField?: "max_completion_tokens" | "max_tokens" }>(model)
    ?.maxTokensField;
}

function reasoningEffortMap(model: unknown): Record<string, string> | undefined {
  return readCompat<{ reasoningEffortMap?: Record<string, string> }>(model)?.reasoningEffortMap;
}

describe("resolveMistralCompatPatch", () => {
  it("enables reasoning_effort mapping for mistral-small-latest", () => {
    expect(resolveMistralCompatPatch({ id: MISTRAL_SMALL_LATEST_ID })).toMatchObject({
      maxTokensField: "max_tokens",
      reasoningEffortMap: expect.objectContaining({ high: "high", off: "none" }),
      supportsReasoningEffort: true,
      supportsStore: false,
    });
  });

  it("disables reasoning_effort for other Mistral model ids", () => {
    expect(resolveMistralCompatPatch({ id: "mistral-large-latest" })).toEqual({
      ...MISTRAL_MODEL_TRANSPORT_PATCH,
      supportsReasoningEffort: false,
    });
  });
});

describe("applyMistralModelCompat", () => {
  it("applies the Mistral request-shape compat flags", () => {
    const normalized = applyMistralModelCompat({});
    expect(supportsStore(normalized)).toBe(false);
    expect(supportsReasoningEffort(normalized)).toBe(false);
    expect(maxTokensField(normalized)).toBe("max_tokens");
    expect(reasoningEffortMap(normalized)).toBeUndefined();
  });

  it("applies reasoning compat for mistral-small-latest", () => {
    const normalized = applyMistralModelCompat({ id: MISTRAL_SMALL_LATEST_ID });
    expect(supportsReasoningEffort(normalized)).toBe(true);
    expect(reasoningEffortMap(normalized)?.high).toBe("high");
    expect(reasoningEffortMap(normalized)?.off).toBe("none");
  });

  it("overrides explicit compat values that would trigger 422s", () => {
    const normalized = applyMistralModelCompat({
      compat: {
        maxTokensField: "max_completion_tokens" as const,
        supportsReasoningEffort: true,
        supportsStore: true,
      },
    });
    expect(supportsStore(normalized)).toBe(false);
    expect(supportsReasoningEffort(normalized)).toBe(false);
    expect(maxTokensField(normalized)).toBe("max_tokens");
  });

  it("overrides explicit compat on mistral-small-latest except reasoning enablement", () => {
    const normalized = applyMistralModelCompat({
      compat: {
        maxTokensField: "max_completion_tokens" as const,
        supportsReasoningEffort: false,
        supportsStore: true,
      },
      id: MISTRAL_SMALL_LATEST_ID,
    });
    expect(supportsStore(normalized)).toBe(false);
    expect(supportsReasoningEffort(normalized)).toBe(true);
    expect(maxTokensField(normalized)).toBe("max_tokens");
  });

  it("returns the same object when the compat patch is already present", () => {
    const model = {
      compat: {
        maxTokensField: "max_tokens" as const,
        supportsReasoningEffort: false,
        supportsStore: false,
      },
    };
    expect(applyMistralModelCompat(model)).toBe(model);
  });

  it("returns the same object when mistral-small-latest compat is fully normalized", () => {
    const model = {
      compat: resolveMistralCompatPatch({ id: MISTRAL_SMALL_LATEST_ID }),
      id: MISTRAL_SMALL_LATEST_ID,
    };
    expect(applyMistralModelCompat(model)).toBe(model);
  });

  it("contributes Mistral transport compat for native, provider-family, and hinted custom routes", () => {
    expect(
      contributeMistralResolvedModelCompat({
        model: {
          api: "openai-completions",
          baseUrl: "https://proxy.example/v1",
          provider: "mistral",
        },
        modelId: "mistral-large-latest",
      }),
    ).toEqual(MISTRAL_MODEL_TRANSPORT_PATCH);

    expect(
      contributeMistralResolvedModelCompat({
        model: {
          api: "openai-completions",
          baseUrl: "https://api.mistral.ai/v1",
          provider: "custom-mistral-host",
        },
        modelId: "custom-model",
      }),
    ).toEqual(MISTRAL_MODEL_TRANSPORT_PATCH);

    expect(
      contributeMistralResolvedModelCompat({
        model: {
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          provider: "openrouter",
        },
        modelId: "mistralai/mistral-small-3.2",
      }),
    ).toEqual(MISTRAL_MODEL_TRANSPORT_PATCH);
  });
});
