import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixScopedEnvVarNames } from "../env-vars.js";
import type { CoreConfig } from "../types.js";
import {
  listMatrixAccountIds,
  resolveConfiguredMatrixBotUserIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
} from "./accounts.js";
import type { MatrixStoredCredentials } from "./credentials-read.js";

const loadMatrixCredentialsMock = vi.hoisted(() =>
  vi.fn<(env?: NodeJS.ProcessEnv, accountId?: string | null) => MatrixStoredCredentials | null>(
    () => null,
  ),
);

vi.mock("./credentials-read.js", () => ({
  credentialsMatchConfig: () => false,
  loadMatrixCredentials: (env?: NodeJS.ProcessEnv, accountId?: string | null) =>
    loadMatrixCredentialsMock(env, accountId),
}));

const envKeys = [
  "MATRIX_HOMESERVER",
  "MATRIX_USER_ID",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_PASSWORD",
  "MATRIX_DEVICE_NAME",
  "MATRIX_DEFAULT_HOMESERVER",
  "MATRIX_DEFAULT_ACCESS_TOKEN",
  getMatrixScopedEnvVarNames("team-ops").homeserver,
  getMatrixScopedEnvVarNames("team-ops").accessToken,
];

type MatrixRoomScopeKey = "groups" | "rooms";

function createMatrixAccountConfig(accessToken: string) {
  return {
    accessToken,
    homeserver: "https://matrix.example.org",
  };
}

function createMatrixScopedEntriesConfig(scopeKey: MatrixRoomScopeKey): CoreConfig {
  return {
    channels: {
      matrix: {
        [scopeKey]: {
          "!axis-room:example.org": {
            account: "axis",
            enabled: true,
          },
          "!default-room:example.org": {
            account: "default",
            enabled: true,
          },
          "!unassigned-room:example.org": {
            enabled: true,
          },
        },
        accounts: {
          axis: createMatrixAccountConfig("axis-token"),
          default: createMatrixAccountConfig("default-token"),
        },
      },
    },
  } as unknown as CoreConfig;
}

function createMatrixTopLevelDefaultScopedEntriesConfig(scopeKey: MatrixRoomScopeKey): CoreConfig {
  return {
    channels: {
      matrix: {
        ...createMatrixAccountConfig("default-token"),
        [scopeKey]: {
          "!default-room:example.org": {
            account: "default",
            enabled: true,
          },
          "!ops-room:example.org": {
            account: "ops",
            enabled: true,
          },
          "!shared-room:example.org": {
            enabled: true,
          },
        },
        accounts: {
          ops: createMatrixAccountConfig("ops-token"),
        },
      },
    },
  } as unknown as CoreConfig;
}

function expectMatrixScopedEntries(
  cfg: CoreConfig,
  scopeKey: MatrixRoomScopeKey,
  accountId: string,
  expected: Record<string, { enabled: true; account?: string }>,
): void {
  expect(resolveMatrixAccount({ accountId, cfg }).config[scopeKey]).toEqual(expected);
}

function expectMultiAccountMatrixScopedEntries(
  cfg: CoreConfig,
  scopeKey: MatrixRoomScopeKey,
): void {
  expectMatrixScopedEntries(cfg, scopeKey, "default", {
    "!default-room:example.org": {
      account: "default",
      enabled: true,
    },
    "!unassigned-room:example.org": {
      enabled: true,
    },
  });
  expectMatrixScopedEntries(cfg, scopeKey, "axis", {
    "!axis-room:example.org": {
      account: "axis",
      enabled: true,
    },
    "!unassigned-room:example.org": {
      enabled: true,
    },
  });
}

function expectTopLevelDefaultMatrixScopedEntries(
  cfg: CoreConfig,
  scopeKey: MatrixRoomScopeKey,
): void {
  expectMatrixScopedEntries(cfg, scopeKey, "default", {
    "!default-room:example.org": {
      account: "default",
      enabled: true,
    },
    "!shared-room:example.org": {
      enabled: true,
    },
  });
  expectMatrixScopedEntries(cfg, scopeKey, "ops", {
    "!ops-room:example.org": {
      account: "ops",
      enabled: true,
    },
    "!shared-room:example.org": {
      enabled: true,
    },
  });
}

describe("resolveMatrixAccount", () => {
  let prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    loadMatrixCredentialsMock.mockReset().mockReturnValue(null);
    prevEnv = {};
    for (const key of envKeys) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = prevEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("treats access-token-only config as configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accessToken: "tok-access",
          homeserver: "https://matrix.example.org",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });

  it("treats SecretRef access-token config as configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accessToken: { id: "value", provider: "matrix-file", source: "file" },
          homeserver: "https://matrix.example.org",
        },
      },
      secrets: {
        providers: {
          "matrix-file": {
            path: "/tmp/matrix-token",
            source: "file",
          },
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });

  it("treats accounts.default SecretRef access-token config as configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            default: {
              accessToken: { id: "value", provider: "matrix-file", source: "file" },
              homeserver: "https://matrix.example.org",
            },
          },
        },
      },
      secrets: {
        providers: {
          "matrix-file": {
            path: "/tmp/matrix-token",
            source: "file",
          },
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });

  it("treats accounts.default SecretRef password config as configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.example.org",
              password: { id: "value", provider: "matrix-file", source: "file" },
              userId: "@bot:example.org",
            },
          },
        },
      },
      secrets: {
        providers: {
          "matrix-file": {
            path: "/tmp/matrix-password",
            source: "file",
          },
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });

  it("requires userId + password when no access token is set", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(false);
  });

  it("marks password auth as configured when userId is present", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          password: "secret",
          userId: "@bot:example.org",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });

  it("normalizes and de-duplicates configured account ids", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            "Main Bot": {
              accessToken: "main-token",
              homeserver: "https://matrix.example.org",
            },
            OPS: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
            },
            "main-bot": {
              accessToken: "duplicate-token",
              homeserver: "https://matrix.example.org",
            },
          },
          defaultAccount: "Main Bot",
        },
      },
    };

    expect(listMatrixAccountIds(cfg)).toEqual(["main-bot", "ops"]);
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("main-bot");
  });

  it("returns the only named account when no explicit default is set", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
            },
          },
        },
      },
    };

    expect(resolveDefaultMatrixAccountId(cfg)).toBe("ops");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accessToken: "default-token",
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://ops.example.org",
            },
          },
          defaultAccount: "ops",
          homeserver: "https://matrix.example.org",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.accountId).toBe("ops");
    expect(account.homeserver).toBe("https://ops.example.org");
    expect(account.configured).toBe(true);
  });

  it("includes env-backed named accounts in plugin account enumeration", () => {
    const keys = getMatrixScopedEnvVarNames("team-ops");
    process.env[keys.homeserver] = "https://matrix.example.org";
    process.env[keys.accessToken] = "ops-token";

    const cfg: CoreConfig = {
      channels: {
        matrix: {},
      },
    };

    expect(listMatrixAccountIds(cfg)).toEqual(["team-ops"]);
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("team-ops");
  });

  it("includes default accounts backed only by global env vars in plugin account enumeration", () => {
    process.env.MATRIX_HOMESERVER = "https://matrix.example.org";
    process.env.MATRIX_ACCESS_TOKEN = "default-token";

    const cfg: CoreConfig = {};

    expect(listMatrixAccountIds(cfg)).toEqual(["default"]);
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });

  it("treats mixed default and named env-backed accounts as multi-account", () => {
    const keys = getMatrixScopedEnvVarNames("team-ops");
    process.env.MATRIX_HOMESERVER = "https://matrix.example.org";
    process.env.MATRIX_ACCESS_TOKEN = "default-token";
    process.env[keys.homeserver] = "https://matrix.example.org";
    process.env[keys.accessToken] = "ops-token";

    const cfg: CoreConfig = {
      channels: {
        matrix: {},
      },
    };

    expect(listMatrixAccountIds(cfg)).toEqual(["default", "team-ops"]);
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });

  it("includes a top-level configured default account alongside named accounts", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accessToken: "default-token",
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
            },
          },
          homeserver: "https://matrix.example.org",
        },
      },
    };

    expect(listMatrixAccountIds(cfg)).toEqual(["default", "ops"]);
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });

  it("does not materialize a default account from shared top-level defaults alone", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
            },
          },
          enabled: true,
          name: "Shared Defaults",
        },
      },
    };

    expect(listMatrixAccountIds(cfg)).toEqual(["ops"]);
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("ops");
  });

  it('uses the synthetic "default" account when multiple named accounts need explicit selection', () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            alpha: {
              accessToken: "alpha-token",
              homeserver: "https://matrix.example.org",
            },
            beta: {
              accessToken: "beta-token",
              homeserver: "https://matrix.example.org",
            },
          },
        },
      },
    };

    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });

  it("collects other configured Matrix account user ids for bot detection", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accessToken: "main-token",
          accounts: {
            alerts: {
              accessToken: "alerts-token",
              homeserver: "https://matrix.example.org",
              userId: "@alerts:example.org",
            },
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
            },
          },
          homeserver: "https://matrix.example.org",
          userId: "@main:example.org",
        },
      },
    };

    expect(
      [
        ...resolveConfiguredMatrixBotUserIds({
          accountId: "ops",
          cfg,
        }),
      ].toSorted(),
    ).toEqual(["@alerts:example.org", "@main:example.org"]);
  });

  it("honors injected env when detecting configured bot accounts", () => {
    const env = {
      MATRIX_ACCESS_TOKEN: "main-token",
      MATRIX_ALERTS_ACCESS_TOKEN: "alerts-token",
      MATRIX_ALERTS_HOMESERVER: "https://matrix.example.org",
      MATRIX_ALERTS_USER_ID: "@alerts:example.org",
      MATRIX_HOMESERVER: "https://matrix.example.org",
      MATRIX_USER_ID: "@main:example.org",
    } as NodeJS.ProcessEnv;

    const cfg: CoreConfig = {
      channels: {
        matrix: {},
      },
    };

    expect(
      [
        ...resolveConfiguredMatrixBotUserIds({
          accountId: "ops",
          cfg,
          env,
        }),
      ].toSorted(),
    ).toEqual(["@alerts:example.org", "@main:example.org"]);
  });

  it("falls back to stored credentials when an access-token-only account omits userId", () => {
    loadMatrixCredentialsMock.mockImplementation(
      (env?: NodeJS.ProcessEnv, accountId?: string | null) =>
        accountId === "ops"
          ? {
              accessToken: "ops-token",
              createdAt: "2026-03-19T00:00:00.000Z",
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
            }
          : null,
    );

    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accessToken: "main-token",
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
            },
          },
          homeserver: "https://matrix.example.org",
          userId: "@main:example.org",
        },
      },
    };

    expect([
      ...resolveConfiguredMatrixBotUserIds({
        accountId: "default",
        cfg,
      }),
    ]).toEqual(["@ops:example.org"]);
  });

  it("preserves shared nested dm and actions config when an account overrides one field", () => {
    const account = resolveMatrixAccount({
      accountId: "ops",
      cfg: {
        channels: {
          matrix: {
            accessToken: "main-token",
            accounts: {
              ops: {
                accessToken: "ops-token",
                actions: {
                  messages: false,
                },
                dm: {
                  allowFrom: ["@ops:example.org"],
                },
              },
            },
            actions: {
              messages: true,
              reactions: true,
            },
            dm: {
              enabled: true,
              policy: "pairing",
            },
            homeserver: "https://matrix.example.org",
          },
        },
      },
    });

    expect(account.config.dm).toEqual({
      allowFrom: ["@ops:example.org"],
      enabled: true,
      policy: "pairing",
    });
    expect(account.config.actions).toEqual({
      messages: false,
      reactions: true,
    });
  });

  it("filters channel-level groups by room account in multi-account setups", () => {
    expectMultiAccountMatrixScopedEntries(createMatrixScopedEntriesConfig("groups"), "groups");
  });

  it("filters channel-level groups when the default account is configured at the top level", () => {
    expectTopLevelDefaultMatrixScopedEntries(
      createMatrixTopLevelDefaultScopedEntriesConfig("groups"),
      "groups",
    );
  });

  it("filters legacy channel-level rooms by room account in multi-account setups", () => {
    expectMultiAccountMatrixScopedEntries(createMatrixScopedEntriesConfig("rooms"), "rooms");
  });

  it("filters legacy channel-level rooms when the default account is configured at the top level", () => {
    expectTopLevelDefaultMatrixScopedEntries(
      createMatrixTopLevelDefaultScopedEntriesConfig("rooms"),
      "rooms",
    );
  });

  it("honors injected env when scoping room entries in multi-account setups", () => {
    const env = {
      MATRIX_ACCESS_TOKEN: "default-token",
      MATRIX_HOMESERVER: "https://matrix.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
      MATRIX_OPS_HOMESERVER: "https://matrix.example.org",
    } as NodeJS.ProcessEnv;

    const cfg = {
      channels: {
        matrix: {
          groups: {
            "!default-room:example.org": {
              account: "default",
              enabled: true,
            },
            "!ops-room:example.org": {
              account: "ops",
              enabled: true,
            },
            "!shared-room:example.org": {
              enabled: true,
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(resolveMatrixAccount({ accountId: "ops", cfg, env }).config.groups).toEqual({
      "!ops-room:example.org": {
        account: "ops",
        enabled: true,
      },
      "!shared-room:example.org": {
        enabled: true,
      },
    });
  });

  it("keeps scoped groups bound to their account even when only one account is active", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
            },
          },
          groups: {
            "!default-room:example.org": {
              account: "default",
              enabled: true,
            },
            "!shared-room:example.org": {
              enabled: true,
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(resolveMatrixAccount({ accountId: "ops", cfg }).config.groups).toEqual({
      "!shared-room:example.org": {
        enabled: true,
      },
    });
  });

  it("keeps scoped legacy rooms bound to their account even when only one account is active", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
            },
          },
          rooms: {
            "!default-room:example.org": {
              account: "default",
              enabled: true,
            },
            "!shared-room:example.org": {
              enabled: true,
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(resolveMatrixAccount({ accountId: "ops", cfg }).config.rooms).toEqual({
      "!shared-room:example.org": {
        enabled: true,
      },
    });
  });

  it("lets an account clear inherited groups with an explicit empty map", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              accessToken: "ops-token",
              groups: {},
              homeserver: "https://matrix.example.org",
            },
          },
          groups: {
            "!shared-room:example.org": {
              enabled: true,
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(resolveMatrixAccount({ accountId: "ops", cfg }).config.groups).toBeUndefined();
  });

  it("lets an account clear inherited legacy rooms with an explicit empty map", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
              rooms: {},
            },
          },
          rooms: {
            "!shared-room:example.org": {
              enabled: true,
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(resolveMatrixAccount({ accountId: "ops", cfg }).config.rooms).toBeUndefined();
  });
});
