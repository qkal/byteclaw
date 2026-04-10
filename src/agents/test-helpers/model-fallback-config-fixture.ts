import type { OpenClawConfig } from "../../config/config.js";

export function makeModelFallbackCfg(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          fallbacks: ["anthropic/claude-haiku-3-5"],
          primary: "openai/gpt-4.1-mini",
        },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}
