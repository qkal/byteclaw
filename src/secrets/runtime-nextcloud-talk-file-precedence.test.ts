import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const nextcloudTalkSecrets = loadBundledChannelSecretContractApi("nextcloud-talk");
if (!nextcloudTalkSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Nextcloud Talk secret contract api");
}

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
    getBootstrapChannelPlugin: (id: string) =>
      id === "nextcloud-talk"
        ? {
            secrets: {
              collectRuntimeConfigAssignments: nextcloudTalkSecrets.collectRuntimeConfigAssignments,
            },
          }
        : undefined,
    getBootstrapChannelSecrets: (id: string) =>
      id === "nextcloud-talk"
        ? {
            collectRuntimeConfigAssignments: nextcloudTalkSecrets.collectRuntimeConfigAssignments,
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

describe("secrets runtime snapshot nextcloud talk file precedence", () => {
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

  it("treats top-level Nextcloud Talk botSecret and apiPassword refs as active when file paths are configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          "nextcloud-talk": {
            apiPassword: { id: "NEXTCLOUD_API_PASSWORD", provider: "default", source: "env" },
            apiPasswordFile: "/tmp/missing-nextcloud-api-password-file",
            apiUser: "bot-user",
            botSecret: { id: "NEXTCLOUD_BOT_SECRET", provider: "default", source: "env" },
            botSecretFile: "/tmp/missing-nextcloud-bot-secret-file",
          },
        },
      }),
      env: {
        NEXTCLOUD_API_PASSWORD: "resolved-nextcloud-api-password",
        NEXTCLOUD_BOT_SECRET: "resolved-nextcloud-bot-secret",
      },
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.["nextcloud-talk"]?.botSecret).toBe(
      "resolved-nextcloud-bot-secret",
    );
    expect(snapshot.config.channels?.["nextcloud-talk"]?.apiPassword).toBe(
      "resolved-nextcloud-api-password",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.nextcloud-talk.botSecret",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.nextcloud-talk.apiPassword",
    );
  });

  it("treats account-level Nextcloud Talk botSecret and apiPassword refs as active when file paths are configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          "nextcloud-talk": {
            accounts: {
              work: {
                apiPassword: {
                  id: "NEXTCLOUD_WORK_API_PASSWORD",
                  provider: "default",
                  source: "env",
                },
                apiPasswordFile: "/tmp/missing-nextcloud-work-api-password-file",
                botSecret: { id: "NEXTCLOUD_WORK_BOT_SECRET", provider: "default", source: "env" },
                botSecretFile: "/tmp/missing-nextcloud-work-bot-secret-file",
              },
            },
          },
        },
      }),
      env: {
        NEXTCLOUD_WORK_API_PASSWORD: "resolved-nextcloud-work-api-password",
        NEXTCLOUD_WORK_BOT_SECRET: "resolved-nextcloud-work-bot-secret",
      },
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    const workAccount = snapshot.config.channels?.["nextcloud-talk"]?.accounts?.work as
      | { botSecret?: unknown; apiPassword?: unknown }
      | undefined;
    expect(workAccount?.botSecret).toBe("resolved-nextcloud-work-bot-secret");
    expect(workAccount?.apiPassword).toBe("resolved-nextcloud-work-api-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.nextcloud-talk.accounts.work.botSecret",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.nextcloud-talk.accounts.work.apiPassword",
    );
  });
});
