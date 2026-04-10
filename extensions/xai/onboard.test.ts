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
import { XAI_DEFAULT_MODEL_REF, applyXaiConfig, applyXaiProviderConfig } from "./onboard.js";

describe("xai onboard", () => {
  it("adds xAI provider with correct settings", () => {
    const cfg = applyXaiConfig({});
    expect(cfg.models?.providers?.xai).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(XAI_DEFAULT_MODEL_REF);
  });

  it("merges xAI models and keeps existing provider overrides", () => {
    const cfg = applyXaiProviderConfig(
      createLegacyProviderConfig({
        api: "anthropic-messages",
        modelId: "custom-model",
        modelName: "Custom",
        providerId: "xai",
      }),
    );

    expect(cfg.models?.providers?.xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.models?.providers?.xai?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.xai?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.xai?.models.map((m) => m.id)).toEqual(
      expect.arrayContaining([
        "custom-model",
        "grok-4",
        "grok-4-1-fast",
        "grok-4.20-beta-latest-reasoning",
        "grok-code-fast-1",
      ]),
    );
  });

  it("adds expected alias for the default model", () => {
    const cfg = applyXaiProviderConfig({});
    expect(cfg.agents?.defaults?.models?.[XAI_DEFAULT_MODEL_REF]?.alias).toBe("Grok");
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyXaiConfig(createConfigWithFallbacks());
    expect(resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)).toEqual([
      ...EXPECTED_FALLBACKS,
    ]);
  });
});
