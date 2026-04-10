import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  namedAccountPromotionKeys as matrixNamedAccountPromotionKeys,
  singleAccountKeysToMove as matrixSingleAccountKeysToMove,
  resolveSingleAccountPromotionTarget as resolveMatrixSingleAccountPromotionTarget,
} from "../../plugin-sdk/matrix.js";
import { singleAccountKeysToMove as telegramSingleAccountKeysToMove } from "../../plugin-sdk/telegram.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  applySetupAccountConfigPatch,
  clearSetupPromotionRuntimeModuleCache,
  createEnvPatchedAccountSetupAdapter,
  createPatchedAccountSetupAdapter,
  moveSingleAccountChannelSectionToDefaultAccount,
  prepareScopedSetupConfig,
} from "./setup-helpers.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
          setup: {
            namedAccountPromotionKeys: matrixNamedAccountPromotionKeys,
            resolveSingleAccountPromotionTarget: resolveMatrixSingleAccountPromotionTarget,
            singleAccountKeysToMove: matrixSingleAccountKeysToMove,
          },
        },
        pluginId: "matrix",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          setup: {
            singleAccountKeysToMove: telegramSingleAccountKeysToMove,
          },
        },
        pluginId: "telegram",
        source: "test",
      },
    ]),
  );
});

afterEach(() => {
  clearSetupPromotionRuntimeModuleCache();
  resetPluginRuntimeStateForTest();
});

describe("applySetupAccountConfigPatch", () => {
  it("patches top-level config for default account and enables channel", () => {
    const next = applySetupAccountConfigPatch({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg: asConfig({
        channels: {
          "demo-setup": {
            enabled: false,
            webhookPath: "/old",
          },
        },
      }),
      channelKey: "demo-setup",
      patch: { botToken: "tok", webhookPath: "/new" },
    });

    expect(next.channels?.["demo-setup"]).toMatchObject({
      botToken: "tok",
      enabled: true,
      webhookPath: "/new",
    });
  });

  it("patches named account config and preserves existing account enabled flag", () => {
    const next = applySetupAccountConfigPatch({
      accountId: "work",
      cfg: asConfig({
        channels: {
          "demo-setup": {
            accounts: {
              work: { botToken: "old", enabled: false },
            },
            enabled: false,
          },
        },
      }),
      channelKey: "demo-setup",
      patch: { botToken: "new" },
    });

    expect(next.channels?.["demo-setup"]).toMatchObject({
      accounts: {
        work: { botToken: "new", enabled: false },
      },
      enabled: true,
    });
  });

  it("normalizes account id and preserves other accounts", () => {
    const next = applySetupAccountConfigPatch({
      accountId: "Work Team",
      cfg: asConfig({
        channels: {
          "demo-setup": {
            accounts: {
              personal: { botToken: "personal-token" },
            },
          },
        },
      }),
      channelKey: "demo-setup",
      patch: { botToken: "work-token" },
    });

    expect(next.channels?.["demo-setup"]).toMatchObject({
      accounts: {
        personal: { botToken: "personal-token" },
        "work-team": { botToken: "work-token", enabled: true },
      },
    });
  });
});

describe("createPatchedAccountSetupAdapter", () => {
  it("stores default-account patch at channel root", () => {
    const adapter = createPatchedAccountSetupAdapter({
      buildPatch: (input) => ({ botToken: input.token }),
      channelKey: "demo-setup",
    });

    const next = adapter.applyAccountConfig({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg: asConfig({ channels: { "demo-setup": { enabled: false } } }),
      input: { name: "Personal", token: "tok" },
    });

    expect(next.channels?.["demo-setup"]).toMatchObject({
      botToken: "tok",
      enabled: true,
      name: "Personal",
    });
  });

  it("migrates base name into the default account before patching a named account", () => {
    const adapter = createPatchedAccountSetupAdapter({
      buildPatch: (input) => ({ botToken: input.token }),
      channelKey: "demo-setup",
    });

    const next = adapter.applyAccountConfig({
      accountId: "Work Team",
      cfg: asConfig({
        channels: {
          "demo-setup": {
            accounts: {
              work: { botToken: "old" },
            },
            name: "Personal",
          },
        },
      }),
      input: { name: "Work", token: "new" },
    });

    expect(next.channels?.["demo-setup"]).toMatchObject({
      accounts: {
        default: { name: "Personal" },
        work: { botToken: "old" },
        "work-team": { botToken: "new", enabled: true, name: "Work" },
      },
    });
    expect(next.channels?.["demo-setup"]).not.toHaveProperty("name");
  });

  it("can store the default account in accounts.default", () => {
    const adapter = createPatchedAccountSetupAdapter({
      alwaysUseAccounts: true,
      buildPatch: (input) => ({ authDir: input.authDir }),
      channelKey: "demo-accounts",
    });

    const next = adapter.applyAccountConfig({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg: asConfig({ channels: { "demo-accounts": {} } }),
      input: { authDir: "/tmp/auth", name: "Phone" },
    });

    expect(next.channels?.["demo-accounts"]).toMatchObject({
      accounts: {
        default: {
          authDir: "/tmp/auth",
          enabled: true,
          name: "Phone",
        },
      },
    });
    expect(next.channels?.["demo-accounts"]).not.toHaveProperty("enabled");
    expect(next.channels?.["demo-accounts"]).not.toHaveProperty("authDir");
  });
});

describe("moveSingleAccountChannelSectionToDefaultAccount", () => {
  it("moves Matrix allowBots into the promoted default account", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          matrix: {
            accessToken: "token",
            allowBots: "mentions",
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
          },
        },
      }),
      channelKey: "matrix",
    });

    expect(next.channels?.matrix).toMatchObject({
      accounts: {
        default: {
          accessToken: "token",
          allowBots: "mentions",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
      },
    });
    expect(next.channels?.matrix?.allowBots).toBeUndefined();
  });

  it("promotes legacy Matrix keys into the sole named account when defaultAccount is unset", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          matrix: {
            accessToken: "token",
            accounts: {
              main: {
                enabled: true,
              },
            },
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
          },
        },
      }),
      channelKey: "matrix",
    });

    expect(next.channels?.matrix).toMatchObject({
      accounts: {
        main: {
          accessToken: "token",
          enabled: true,
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
      },
    });
    expect(next.channels?.matrix?.accounts?.default).toBeUndefined();
    expect(next.channels?.matrix?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accessToken).toBeUndefined();
  });

  it("promotes legacy Matrix keys into an existing non-canonical default account key", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          matrix: {
            accessToken: "token",
            accounts: {
              Ops: {
                enabled: true,
              },
            },
            defaultAccount: "ops",
            homeserver: "https://matrix.example.org",
            userId: "@ops:example.org",
          },
        },
      }),
      channelKey: "matrix",
    });

    expect(next.channels?.matrix).toMatchObject({
      accounts: {
        Ops: {
          accessToken: "token",
          enabled: true,
          homeserver: "https://matrix.example.org",
          userId: "@ops:example.org",
        },
      },
      defaultAccount: "ops",
    });
    expect(next.channels?.matrix?.accounts?.ops).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.default).toBeUndefined();
    expect(next.channels?.matrix?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accessToken).toBeUndefined();
  });
});

describe("createEnvPatchedAccountSetupAdapter", () => {
  it("rejects env mode for named accounts and requires credentials otherwise", () => {
    const adapter = createEnvPatchedAccountSetupAdapter({
      buildPatch: (input) => ({ token: input.token }),
      channelKey: "demo-env",
      defaultAccountOnlyEnvError: "env only on default",
      hasCredentials: (input) => Boolean(input.token || input.tokenFile),
      missingCredentialError: "token required",
    });

    expect(
      adapter.validateInput?.({
        accountId: "work",
        cfg: asConfig({}),
        input: { useEnv: true },
      }),
    ).toBe("env only on default");

    expect(
      adapter.validateInput?.({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: asConfig({}),
        input: {},
      }),
    ).toBe("token required");

    expect(
      adapter.validateInput?.({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: asConfig({}),
        input: { token: "tok" },
      }),
    ).toBeNull();
  });
});

describe("prepareScopedSetupConfig", () => {
  it("stores the name and migrates it for named accounts when requested", () => {
    const next = prepareScopedSetupConfig({
      accountId: "Work Team",
      cfg: asConfig({
        channels: {
          "demo-scoped": {
            name: "Personal",
          },
        },
      }),
      channelKey: "demo-scoped",
      migrateBaseName: true,
      name: "Work",
    });

    expect(next.channels?.["demo-scoped"]).toMatchObject({
      accounts: {
        default: { name: "Personal" },
        "work-team": { name: "Work" },
      },
    });
    expect(next.channels?.["demo-scoped"]).not.toHaveProperty("name");
  });

  it("keeps the base shape for the default account when migration is disabled", () => {
    const next = prepareScopedSetupConfig({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg: asConfig({ channels: { "demo-base": { enabled: true } } }),
      channelKey: "demo-base",
      name: "Libera",
    });

    expect(next.channels?.["demo-base"]).toMatchObject({
      enabled: true,
      name: "Libera",
    });
  });
});
