import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

describe("secrets runtime snapshot inactive telegram surfaces", () => {
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

  it("skips inactive Telegram refs and emits diagnostics", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            accounts: {
              disabled: {
                botToken: {
                  id: "DISABLED_TELEGRAM_ACCOUNT_TOKEN",
                  provider: "default",
                  source: "env",
                },
                enabled: false,
              },
            },
            botToken: { id: "DISABLED_TELEGRAM_BASE_TOKEN", provider: "default", source: "env" },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.channels?.telegram?.botToken).toEqual({
      id: "DISABLED_TELEGRAM_BASE_TOKEN",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "channels.telegram.botToken",
        "channels.telegram.accounts.disabled.botToken",
      ]),
    );
  });
});
