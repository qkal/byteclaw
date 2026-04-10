import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const zaloSecrets = loadBundledChannelSecretContractApi("zalo");
if (!zaloSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Zalo secret contract api");
}

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "zalo"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: zaloSecrets.collectRuntimeConfigAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "zalo"
      ? {
          collectRuntimeConfigAssignments: zaloSecrets.collectRuntimeConfigAssignments,
        }
      : undefined,
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

function loadAuthStoreWithProfiles(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    profiles,
    version: 1,
  };
}

describe("secrets runtime snapshot zalo token activity", () => {
  beforeAll(async () => {
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } = await import("./runtime.js"));
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("treats top-level Zalo botToken refs as active even when tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          zalo: {
            botToken: { id: "ZALO_BOT_TOKEN", provider: "default", source: "env" },
            tokenFile: "/tmp/missing-zalo-token-file",
          },
        },
      }),
      env: {
        ZALO_BOT_TOKEN: "resolved-zalo-token",
      },
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.zalo?.botToken).toBe("resolved-zalo-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.botToken",
    );
  });

  it("treats account-level Zalo botToken refs as active even when tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          zalo: {
            accounts: {
              work: {
                botToken: { id: "ZALO_WORK_BOT_TOKEN", provider: "default", source: "env" },
                tokenFile: "/tmp/missing-zalo-work-token-file",
              },
            },
          },
        },
      }),
      env: {
        ZALO_WORK_BOT_TOKEN: "resolved-zalo-work-token",
      },
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      (snapshot.config.channels?.zalo?.accounts?.work as { botToken?: unknown } | undefined)
        ?.botToken,
    ).toBe("resolved-zalo-work-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.accounts.work.botToken",
    );
  });

  it("treats top-level Zalo botToken refs as active for non-default accounts without overrides", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          zalo: {
            accounts: {
              work: {
                enabled: true,
              },
            },
            botToken: { id: "ZALO_TOP_LEVEL_TOKEN", provider: "default", source: "env" },
          },
        },
      }),
      env: {
        ZALO_TOP_LEVEL_TOKEN: "resolved-zalo-top-level-token",
      },
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.zalo?.botToken).toBe("resolved-zalo-top-level-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.botToken",
    );
  });

  it("treats channels.zalo.accounts.default.botToken refs as active", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          zalo: {
            accounts: {
              default: {
                botToken: { id: "ZALO_DEFAULT_TOKEN", provider: "default", source: "env" },
                enabled: true,
              },
            },
          },
        },
      }),
      env: {
        ZALO_DEFAULT_TOKEN: "resolved-zalo-default-token",
      },
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      (snapshot.config.channels?.zalo?.accounts?.default as { botToken?: unknown } | undefined)
        ?.botToken,
    ).toBe("resolved-zalo-default-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.accounts.default.botToken",
    );
  });
});
