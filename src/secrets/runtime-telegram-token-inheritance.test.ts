import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const telegramSecrets = loadBundledChannelSecretContractApi("telegram");
if (!telegramSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Telegram secret contract api");
}

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
    getBootstrapChannelPlugin: (id: string) =>
      id === "telegram"
        ? {
            secrets: {
              collectRuntimeConfigAssignments: telegramSecrets.collectRuntimeConfigAssignments,
            },
          }
        : undefined,
    getBootstrapChannelSecrets: (id: string) =>
      id === "telegram"
        ? {
            collectRuntimeConfigAssignments: telegramSecrets.collectRuntimeConfigAssignments,
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

describe("secrets runtime snapshot telegram token inheritance", () => {
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

  it("fails when enabled channel surfaces contain unresolved refs", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-agent-main"],
        config: asConfig({
          channels: {
            telegram: {
              accounts: {
                work: {
                  enabled: true,
                },
              },
              botToken: {
                id: "MISSING_ENABLED_TELEGRAM_TOKEN",
                provider: "default",
                source: "env",
              },
            },
          },
        }),
        env: {},
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      }),
    ).rejects.toThrow('Environment variable "MISSING_ENABLED_TELEGRAM_TOKEN" is missing or empty.');
  });

  it("fails when default Telegram account can inherit an unresolved top-level token ref", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-agent-main"],
        config: asConfig({
          channels: {
            telegram: {
              accounts: {
                default: {
                  enabled: true,
                },
              },
              botToken: {
                id: "MISSING_ENABLED_TELEGRAM_TOKEN",
                provider: "default",
                source: "env",
              },
            },
          },
        }),
        env: {},
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      }),
    ).rejects.toThrow('Environment variable "MISSING_ENABLED_TELEGRAM_TOKEN" is missing or empty.');
  });

  it("treats top-level Telegram token as inactive when all enabled accounts override it", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          telegram: {
            accounts: {
              disabled: {
                enabled: false,
              },
              work: {
                botToken: {
                  id: "TELEGRAM_WORK_TOKEN",
                  provider: "default",
                  source: "env",
                },
                enabled: true,
              },
            },
            botToken: {
              id: "UNUSED_TELEGRAM_BASE_TOKEN",
              provider: "default",
              source: "env",
            },
          },
        },
      }),
      env: {
        TELEGRAM_WORK_TOKEN: "telegram-work-token",
      },
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.telegram?.accounts?.work?.botToken).toBe(
      "telegram-work-token",
    );
    expect(snapshot.config.channels?.telegram?.botToken).toEqual({
      id: "UNUSED_TELEGRAM_BASE_TOKEN",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.botToken",
    );
  });

  it("treats Telegram account overrides as enabled when account.enabled is omitted", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-agent-main"],
        config: asConfig({
          channels: {
            telegram: {
              accounts: {
                inheritedEnabled: {
                  botToken: {
                    id: "MISSING_INHERITED_TELEGRAM_ACCOUNT_TOKEN",
                    provider: "default",
                    source: "env",
                  },
                },
              },
              enabled: true,
            },
          },
        }),
        env: {},
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      }),
    ).rejects.toThrow(
      'Environment variable "MISSING_INHERITED_TELEGRAM_ACCOUNT_TOKEN" is missing or empty.',
    );
  });

  it("treats top-level Telegram botToken refs as active when account botToken is blank", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          telegram: {
            accounts: {
              work: {
                botToken: "",
                enabled: true,
              },
            },
            botToken: {
              id: "TELEGRAM_BASE_TOKEN",
              provider: "default",
              source: "env",
            },
          },
        },
      }),
      env: {
        TELEGRAM_BASE_TOKEN: "telegram-base-token",
      },
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.telegram?.botToken).toBe("telegram-base-token");
    expect(snapshot.config.channels?.telegram?.accounts?.work?.botToken).toBe("");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.telegram.botToken",
    );
  });

  it("treats Telegram webhookSecret refs as inactive when webhook mode is not configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          telegram: {
            accounts: {
              work: {
                enabled: true,
              },
            },
            webhookSecret: {
              id: "MISSING_TELEGRAM_WEBHOOK_SECRET",
              provider: "default",
              source: "env",
            },
          },
        },
      }),
      env: {},
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.telegram?.webhookSecret).toEqual({
      id: "MISSING_TELEGRAM_WEBHOOK_SECRET",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.webhookSecret",
    );
  });

  it("treats Telegram top-level botToken refs as inactive when tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          telegram: {
            botToken: {
              id: "MISSING_TELEGRAM_BOT_TOKEN",
              provider: "default",
              source: "env",
            },
            tokenFile: "/tmp/telegram-bot-token",
          },
        },
      }),
      env: {},
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.telegram?.botToken).toEqual({
      id: "MISSING_TELEGRAM_BOT_TOKEN",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.botToken",
    );
  });

  it("treats Telegram account botToken refs as inactive when account tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        channels: {
          telegram: {
            accounts: {
              work: {
                botToken: {
                  id: "MISSING_TELEGRAM_WORK_BOT_TOKEN",
                  provider: "default",
                  source: "env",
                },
                enabled: true,
                tokenFile: "/tmp/telegram-work-bot-token",
              },
            },
          },
        },
      }),
      env: {},
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.telegram?.accounts?.work?.botToken).toEqual({
      id: "MISSING_TELEGRAM_WORK_BOT_TOKEN",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.accounts.work.botToken",
    );
  });
});
