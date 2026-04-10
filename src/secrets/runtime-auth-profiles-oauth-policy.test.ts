import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { prepareSecretsRuntimeSnapshot } from "./runtime.js";

function withAuthProfileMode(mode: "api_key" | "oauth" | "token"): OpenClawConfig {
  return {
    auth: {
      profiles: {
        "anthropic:default": {
          mode,
          provider: "anthropic",
        },
      },
    },
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as OpenClawConfig;
}

describe("secrets runtime oauth auth-profile SecretRef policy", () => {
  it("fails startup snapshot when oauth mode profile uses token SecretRef", async () => {
    const store: AuthProfileStore = {
      profiles: {
        "anthropic:default": {
          provider: "anthropic",
          tokenRef: { id: "ANTHROPIC_TOKEN", provider: "default", source: "env" },
          type: "token",
        },
      },
      version: 1,
    };

    await expect(
      prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-secrets-runtime-main"],
        config: withAuthProfileMode("oauth"),
        env: { ANTHROPIC_TOKEN: "token-value" } as NodeJS.ProcessEnv,
        loadAuthStore: () => store,
        loadablePluginOrigins: new Map(),
      }),
    ).rejects.toThrow(/OAuth \+ SecretRef is not supported/i);
  });

  it("keeps token SecretRef support when the profile mode is token", async () => {
    const store: AuthProfileStore = {
      profiles: {
        "anthropic:default": {
          provider: "anthropic",
          tokenRef: { id: "ANTHROPIC_TOKEN", provider: "default", source: "env" },
          type: "token",
        },
      },
      version: 1,
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-secrets-runtime-main"],
      config: withAuthProfileMode("token"),
      env: { ANTHROPIC_TOKEN: "token-value" } as NodeJS.ProcessEnv,
      loadAuthStore: () => store,
      loadablePluginOrigins: new Map(),
    });

    const resolved = snapshot.authStores[0]?.store.profiles["anthropic:default"];
    expect(resolved).toMatchObject({
      token: "token-value",
      type: "token",
    });
  });
});
