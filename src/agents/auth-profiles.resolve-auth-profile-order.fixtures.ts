import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles.js";

export const ANTHROPIC_STORE: AuthProfileStore = {
  profiles: {
    "anthropic:default": {
      key: "sk-default",
      provider: "anthropic",
      type: "api_key",
    },
    "anthropic:work": {
      key: "sk-work",
      provider: "anthropic",
      type: "api_key",
    },
  },
  version: 1,
};

export const ANTHROPIC_CFG: OpenClawConfig = {
  auth: {
    profiles: {
      "anthropic:default": { mode: "api_key", provider: "anthropic" },
      "anthropic:work": { mode: "api_key", provider: "anthropic" },
    },
  },
};
