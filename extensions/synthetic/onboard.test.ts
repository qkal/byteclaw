import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { createLegacyProviderConfig } from "../../test/helpers/plugins/onboard-config.js";
import { SYNTHETIC_DEFAULT_MODEL_REF as SYNTHETIC_DEFAULT_MODEL_REF_PUBLIC } from "./api.js";
import {
  SYNTHETIC_DEFAULT_MODEL_REF,
  applySyntheticConfig,
  applySyntheticProviderConfig,
} from "./onboard.js";

describe("synthetic onboard", () => {
  it("adds synthetic provider with correct settings", () => {
    const cfg = applySyntheticConfig({});
    expect(cfg.models?.providers?.synthetic).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://api.synthetic.new/anthropic",
    });
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      SYNTHETIC_DEFAULT_MODEL_REF_PUBLIC,
    );
  });

  it("merges existing synthetic provider models", () => {
    const cfg = applySyntheticProviderConfig(
      createLegacyProviderConfig({
        api: "openai-completions",
        providerId: "synthetic",
      }),
    );
    expect(cfg.models?.providers?.synthetic?.baseUrl).toBe("https://api.synthetic.new/anthropic");
    expect(cfg.models?.providers?.synthetic?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.synthetic?.apiKey).toBe("old-key");
    const ids = cfg.models?.providers?.synthetic?.models.map((m) => m.id);
    expect(ids).toContain("old-model");
    expect(ids).toContain(SYNTHETIC_DEFAULT_MODEL_REF.replace(/^synthetic\//, ""));
  });
});
