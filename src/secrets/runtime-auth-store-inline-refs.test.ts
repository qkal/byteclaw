import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();

function loadAuthStoreWithProfiles(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    profiles,
    version: 1,
  };
}

describe("secrets runtime snapshot inline auth-store refs", () => {
  beforeAll(() => {});

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("normalizes inline SecretRef object on token to tokenRef", async () => {
    const config: OpenClawConfig = { models: {}, secrets: {} };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config,
      env: { MY_TOKEN: "resolved-token-value" },
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:inline-token": {
            provider: "custom",
            token: { source: "env", provider: "default", id: "MY_TOKEN" } as unknown as string,
            type: "token",
          },
        }),
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    const profile = snapshot.authStores[0]?.store.profiles["custom:inline-token"] as Record<
      string,
      unknown
    >;
    expect(profile.tokenRef).toEqual({ id: "MY_TOKEN", provider: "default", source: "env" });
    activateSecretsRuntimeSnapshot(snapshot);
    expect(profile.token).toBe("resolved-token-value");
  });

  it("normalizes inline SecretRef object on key to keyRef", async () => {
    const config: OpenClawConfig = { models: {}, secrets: {} };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config,
      env: { MY_KEY: "resolved-key-value" },
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:inline-key": {
            key: { source: "env", provider: "default", id: "MY_KEY" } as unknown as string,
            provider: "custom",
            type: "api_key",
          },
        }),
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    const profile = snapshot.authStores[0]?.store.profiles["custom:inline-key"] as Record<
      string,
      unknown
    >;
    expect(profile.keyRef).toEqual({ id: "MY_KEY", provider: "default", source: "env" });
    activateSecretsRuntimeSnapshot(snapshot);
    expect(profile.key).toBe("resolved-key-value");
  });

  it("keeps explicit keyRef when inline key SecretRef is also present", async () => {
    const config: OpenClawConfig = { models: {}, secrets: {} };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config,
      env: {
        PRIMARY_KEY: "primary-key-value",
        SHADOW_KEY: "shadow-key-value",
      },
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:explicit-keyref": {
            key: { source: "env", provider: "default", id: "SHADOW_KEY" } as unknown as string,
            keyRef: { id: "PRIMARY_KEY", provider: "default", source: "env" },
            provider: "custom",
            type: "api_key",
          },
        }),
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    const profile = snapshot.authStores[0]?.store.profiles["custom:explicit-keyref"] as Record<
      string,
      unknown
    >;
    expect(profile.keyRef).toEqual({ id: "PRIMARY_KEY", provider: "default", source: "env" });
    activateSecretsRuntimeSnapshot(snapshot);
    expect(profile.key).toBe("primary-key-value");
  });
});
