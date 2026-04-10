import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_FALLBACKS,
  createConfigWithFallbacks,
  createLegacyProviderConfig,
} from "../../test/helpers/plugins/onboard-config.js";
import { buildMistralModelDefinition as buildBundledMistralModelDefinition } from "./model-definitions.js";
import {
  MISTRAL_DEFAULT_MODEL_REF,
  applyMistralConfig,
  applyMistralProviderConfig,
} from "./onboard.js";

describe("mistral onboard", () => {
  it("adds Mistral provider with correct settings", () => {
    const cfg = applyMistralConfig({});
    expect(cfg.models?.providers?.mistral).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
    });
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      MISTRAL_DEFAULT_MODEL_REF,
    );
  });

  it("merges Mistral models and keeps existing provider overrides", () => {
    const cfg = applyMistralProviderConfig(
      createLegacyProviderConfig({
        api: "anthropic-messages",
        modelId: "custom-model",
        modelName: "Custom",
        providerId: "mistral",
      }),
    );

    expect(cfg.models?.providers?.mistral?.baseUrl).toBe("https://api.mistral.ai/v1");
    expect(cfg.models?.providers?.mistral?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.mistral?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.mistral?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "mistral-large-latest",
    ]);
    const mistralDefault = cfg.models?.providers?.mistral?.models.find(
      (model) => model.id === "mistral-large-latest",
    );
    expect(mistralDefault?.contextWindow).toBe(262_144);
    expect(mistralDefault?.maxTokens).toBe(16_384);
  });

  it("uses the bundled mistral default model definition", () => {
    const bundled = buildBundledMistralModelDefinition();
    const cfg = applyMistralProviderConfig({});
    const defaultModel = cfg.models?.providers?.mistral?.models.find(
      (model) => model.id === bundled.id,
    );

    expect(defaultModel).toMatchObject({
      contextWindow: bundled.contextWindow,
      id: bundled.id,
      maxTokens: bundled.maxTokens,
    });
  });

  it("adds the expected alias for the default model", () => {
    const cfg = applyMistralProviderConfig({});
    expect(cfg.agents?.defaults?.models?.[MISTRAL_DEFAULT_MODEL_REF]?.alias).toBe("Mistral");
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyMistralConfig(createConfigWithFallbacks());
    expect(resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)).toEqual([
      ...EXPECTED_FALLBACKS,
    ]);
  });
});
