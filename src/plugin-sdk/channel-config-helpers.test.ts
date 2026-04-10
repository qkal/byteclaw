import { describe, expect, it } from "vitest";
import { formatPairingApproveHint } from "../channels/plugins/helpers.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  adaptScopedAccountAccessor,
  authorizeConfigWrite,
  createHybridChannelConfigAdapter,
  createHybridChannelConfigBase,
  createScopedAccountConfigAccessors,
  createScopedChannelConfigAdapter,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
  createTopLevelChannelConfigBase,
  mapAllowFromEntries,
  resolveChannelConfigWrites,
  resolveOptionalConfigString,
} from "./channel-config-helpers.js";

const resolveDefaultAccountId = () => DEFAULT_ACCOUNT_ID;

function createConfigWritesCfg() {
  return {
    channels: {
      telegram: {
        accounts: {
          Work: { configWrites: false },
        },
        configWrites: true,
      },
    },
  };
}

function expectAdapterAllowFromAndDefaultTo(adapter: unknown) {
  const channelAdapter = adapter as {
    resolveAllowFrom?: (params: { cfg: object; accountId: string }) => unknown;
    resolveDefaultTo?: (params: { cfg: object; accountId: string }) => unknown;
    setAccountEnabled?: (params: { cfg: object; accountId: string; enabled: boolean }) => {
      channels?: {
        demo?: unknown;
      };
    };
  };

  expect(channelAdapter.resolveAllowFrom?.({ accountId: "alt", cfg: {} })).toEqual(["alt"]);
  expect(channelAdapter.resolveDefaultTo?.({ accountId: "alt", cfg: {} })).toBe("room:123");
  expect(
    channelAdapter.setAccountEnabled?.({
      accountId: "default",
      cfg: {},
      enabled: true,
    })?.channels?.demo,
  ).toEqual({ enabled: true });
}

describe("mapAllowFromEntries", () => {
  it.each([
    {
      expected: ["user", "42"],
      input: ["user", 42],
      name: "coerces allowFrom entries to strings",
    },
    {
      expected: [],
      input: undefined,
      name: "returns empty list for missing input",
    },
  ])("$name", ({ input, expected }) => {
    expect(mapAllowFromEntries(input)).toEqual(expected);
  });
});

describe("resolveOptionalConfigString", () => {
  it.each([
    {
      expected: "room:123",
      input: "  room:123  ",
      name: "trims and returns string values",
    },
    {
      expected: "123",
      input: 123,
      name: "coerces numeric values",
    },
    {
      expected: undefined,
      input: "   ",
      name: "returns undefined for empty string values",
    },
    {
      expected: undefined,
      input: undefined,
      name: "returns undefined for missing values",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveOptionalConfigString(input)).toBe(expected);
  });
});

describe("config write helpers", () => {
  it("matches account ids case-insensitively", () => {
    expect(
      resolveChannelConfigWrites({
        accountId: "work",
        cfg: createConfigWritesCfg(),
        channelId: "telegram",
      }),
    ).toBe(false);
  });

  it("blocks account-scoped writes when the configured account key differs only by case", () => {
    expect(
      authorizeConfigWrite({
        cfg: createConfigWritesCfg(),
        target: {
          kind: "account",
          scope: { accountId: "work", channelId: "telegram" },
        },
      }),
    ).toEqual({
      allowed: false,
      blockedScope: {
        kind: "target",
        scope: { accountId: "work", channelId: "telegram" },
      },
      reason: "target-disabled",
    });
  });
});

describe("adaptScopedAccountAccessor", () => {
  it("binds positional callback args into the shared account context object", () => {
    const accessor = adaptScopedAccountAccessor(({ cfg, accountId }) => ({
      accountId: accountId ?? "default",
      channel: cfg.channels?.demo,
    }));

    expect(
      accessor(
        {
          channels: {
            demo: {
              enabled: true,
            },
          },
        },
        "alt",
      ),
    ).toEqual({
      accountId: "alt",
      channel: {
        enabled: true,
      },
    });
  });
});

describe("createScopedAccountConfigAccessors", () => {
  it("maps allowFrom and defaultTo from the resolved account", () => {
    const accessors = createScopedAccountConfigAccessors({
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).toUpperCase()),
      resolveAccount: ({ accountId }) => ({
        allowFrom: accountId ? [accountId, 42] : ["fallback"],
        defaultTo: " room:123 ",
      }),
      resolveAllowFrom: (account) => account.allowFrom,
      resolveDefaultTo: (account) => account.defaultTo,
    });

    expect(
      accessors.resolveAllowFrom?.({
        accountId: "owner",
        cfg: {},
      }),
    ).toEqual(["owner", "42"]);
    expect(
      accessors.formatAllowFrom?.({
        allowFrom: ["owner"],
        cfg: {},
      }),
    ).toEqual(["OWNER"]);
    expect(
      accessors.resolveDefaultTo?.({
        accountId: "owner",
        cfg: {},
      }),
    ).toBe("room:123");
  });

  it("omits resolveDefaultTo when no selector is provided", () => {
    const accessors = createScopedAccountConfigAccessors({
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
      resolveAccount: () => ({ allowFrom: ["owner"] }),
      resolveAllowFrom: (account) => account.allowFrom,
    });

    expect(accessors.resolveDefaultTo).toBeUndefined();
  });
});

describe("createScopedChannelConfigBase", () => {
  it("wires shared account config CRUD through the section helper", () => {
    const base = createScopedChannelConfigBase({
      clearBaseFields: ["token"],
      defaultAccountId: resolveDefaultAccountId,
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      sectionKey: "demo",
    });

    expect(base.listAccountIds({})).toEqual(["default", "alt"]);
    expect(base.resolveAccount({}, "alt")).toEqual({ accountId: "alt" });
    expect(base.defaultAccountId!({})).toBe("default");
    expect(
      base.setAccountEnabled!({
        accountId: "default",
        cfg: {},
        enabled: true,
      }).channels?.demo,
    ).toEqual({ enabled: true });
    expect(
      base.deleteAccount!({
        accountId: "default",
        cfg: {
          channels: {
            demo: {
              token: "secret",
            },
          },
        },
      }).channels,
    ).toBeUndefined();
  });

  it("can force default account config into accounts.default", () => {
    const base = createScopedChannelConfigBase({
      allowTopLevel: false,
      clearBaseFields: [],
      defaultAccountId: resolveDefaultAccountId,
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      sectionKey: "demo",
    });

    expect(
      base.setAccountEnabled!({
        accountId: "default",
        cfg: {
          channels: {
            demo: {
              token: "secret",
            },
          },
        },
        enabled: true,
      }).channels?.demo,
    ).toEqual({
      accounts: {
        default: { enabled: true },
      },
      token: "secret",
    });
    expect(
      base.deleteAccount!({
        accountId: "default",
        cfg: {
          channels: {
            demo: {
              accounts: {
                default: { enabled: true },
              },
              token: "secret",
            },
          },
        },
      }).channels?.demo,
    ).toEqual({
      accounts: undefined,
      token: "secret",
    });
  });
});

describe("createScopedChannelConfigAdapter", () => {
  it("combines scoped CRUD and allowFrom accessors", () => {
    const adapter = createScopedChannelConfigAdapter({
      clearBaseFields: ["token"],
      defaultAccountId: resolveDefaultAccountId,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).toUpperCase()),
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId ?? "default",
        allowFrom: accountId ? [accountId] : ["fallback"],
        defaultTo: " room:123 ",
      }),
      resolveAllowFrom: (account) => account.allowFrom,
      resolveDefaultTo: (account) => account.defaultTo,
      sectionKey: "demo",
    });

    expect(adapter.listAccountIds({})).toEqual(["default", "alt"]);
    expect(adapter.resolveAccount({}, "alt")).toEqual({
      accountId: "alt",
      allowFrom: ["alt"],
      defaultTo: " room:123 ",
    });
    expectAdapterAllowFromAndDefaultTo(adapter);
  });
});

describe("createScopedDmSecurityResolver", () => {
  it("builds account-aware DM policy payloads", () => {
    const resolveDmPolicy = createScopedDmSecurityResolver<{
      accountId?: string | null;
      dmPolicy?: string;
      allowFrom?: string[];
    }>({
      channelKey: "demo",
      normalizeEntry: (raw) => raw.toLowerCase(),
      policyPathSuffix: "dmPolicy",
      resolveAllowFrom: (account) => account.allowFrom,
      resolvePolicy: (account) => account.dmPolicy,
    });

    expect(
      resolveDmPolicy({
        account: {
          accountId: "alt",
          allowFrom: ["Owner"],
          dmPolicy: "allowlist",
        },
        accountId: "alt",
        cfg: {
          channels: {
            demo: {
              accounts: {
                alt: {},
              },
            },
          },
        },
      }),
    ).toEqual({
      allowFrom: ["Owner"],
      allowFromPath: "channels.demo.accounts.alt.",
      approveHint: formatPairingApproveHint("demo"),
      normalizeEntry: expect.any(Function),
      policy: "allowlist",
      policyPath: "channels.demo.accounts.alt.dmPolicy",
    });
  });
});

describe("createTopLevelChannelConfigBase", () => {
  it("wires top-level enable/delete semantics", () => {
    const base = createTopLevelChannelConfigBase({
      resolveAccount: () => ({ accountId: "default" }),
      sectionKey: "demo",
    });

    expect(base.listAccountIds({})).toEqual(["default"]);
    expect(base.defaultAccountId!({})).toBe("default");
    expect(
      base.setAccountEnabled!({
        accountId: "default",
        cfg: {},
        enabled: true,
      }).channels?.demo,
    ).toEqual({ enabled: true });
    expect(
      base.deleteAccount!({
        accountId: "default",
        cfg: {
          channels: {
            demo: {
              enabled: true,
            },
          },
        },
      }).channels,
    ).toBeUndefined();
  });

  it("can clear only account-scoped fields while preserving channel settings", () => {
    const base = createTopLevelChannelConfigBase({
      clearBaseFields: ["token", "allowFrom"],
      deleteMode: "clear-fields",
      resolveAccount: () => ({ accountId: "default" }),
      sectionKey: "demo",
    });

    expect(
      base.deleteAccount!({
        accountId: "default",
        cfg: {
          channels: {
            demo: {
              allowFrom: ["owner"],
              markdown: { tables: false },
              token: "secret",
            },
          },
        },
      }).channels?.demo,
    ).toEqual({
      markdown: { tables: false },
    });
  });
});

describe("createTopLevelChannelConfigAdapter", () => {
  it("combines top-level CRUD with separate accessor account resolution", () => {
    const adapter = createTopLevelChannelConfigAdapter<
      { accountId: string; enabled: boolean },
      { allowFrom: string[]; defaultTo: string }
    >({
      clearBaseFields: ["token"],
      deleteMode: "clear-fields",
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
      resolveAccessorAccount: () => ({ allowFrom: ["owner"], defaultTo: " chat:123 " }),
      resolveAccount: () => ({ accountId: "default", enabled: true }),
      resolveAllowFrom: (account) => account.allowFrom,
      resolveDefaultTo: (account) => account.defaultTo,
      sectionKey: "demo",
    });

    expect(adapter.resolveAccount({})).toEqual({ accountId: "default", enabled: true });
    expect(adapter.resolveAllowFrom?.({ cfg: {} })).toEqual(["owner"]);
    expect(adapter.resolveDefaultTo?.({ cfg: {} })).toBe("chat:123");
    expect(
      adapter.deleteAccount!({
        accountId: "default",
        cfg: {
          channels: {
            demo: {
              markdown: { tables: false },
              token: "secret",
            },
          },
        },
      }).channels?.demo,
    ).toEqual({
      markdown: { tables: false },
    });
  });
});

describe("createHybridChannelConfigBase", () => {
  it("writes default account enable at the channel root and named accounts under accounts", () => {
    const base = createHybridChannelConfigBase({
      clearBaseFields: ["token"],
      defaultAccountId: resolveDefaultAccountId,
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      sectionKey: "demo",
    });

    expect(
      base.setAccountEnabled!({
        accountId: "default",
        cfg: {
          channels: {
            demo: {
              accounts: {
                alt: { enabled: false },
              },
            },
          },
        },
        enabled: true,
      }).channels?.demo,
    ).toEqual({
      accounts: {
        alt: { enabled: false },
      },
      enabled: true,
    });
    expect(
      base.setAccountEnabled!({
        accountId: "alt",
        cfg: {},
        enabled: true,
      }).channels?.demo,
    ).toEqual({
      accounts: {
        alt: { enabled: true },
      },
    });
  });

  it("can preserve the section when deleting the default account", () => {
    const base = createHybridChannelConfigBase({
      clearBaseFields: ["token", "name"],
      defaultAccountId: resolveDefaultAccountId,
      listAccountIds: () => ["default", "alt"],
      preserveSectionOnDefaultDelete: true,
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      sectionKey: "demo",
    });

    expect(
      base.deleteAccount!({
        accountId: "default",
        cfg: {
          channels: {
            demo: {
              accounts: {
                alt: { enabled: true },
              },
              name: "bot",
              token: "secret",
            },
          },
        },
      }).channels?.demo,
    ).toEqual({
      accounts: {
        alt: { enabled: true },
      },
    });
  });
});

describe("createHybridChannelConfigAdapter", () => {
  it("combines hybrid CRUD with allowFrom/defaultTo accessors", () => {
    const adapter = createHybridChannelConfigAdapter<
      { accountId: string; enabled: boolean },
      { allowFrom: string[]; defaultTo: string }
    >({
      clearBaseFields: ["token"],
      defaultAccountId: resolveDefaultAccountId,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).toUpperCase()),
      listAccountIds: () => ["default", "alt"],
      preserveSectionOnDefaultDelete: true,
      resolveAccessorAccount: ({ accountId }) => ({
        allowFrom: [accountId ?? "default"],
        defaultTo: " room:123 ",
      }),
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId ?? "default",
        enabled: true,
      }),
      resolveAllowFrom: (account) => account.allowFrom,
      resolveDefaultTo: (account) => account.defaultTo,
      sectionKey: "demo",
    });

    expectAdapterAllowFromAndDefaultTo(adapter);
    expect(
      adapter.deleteAccount!({
        accountId: "default",
        cfg: {
          channels: {
            demo: {
              markdown: { tables: false },
              token: "secret",
            },
          },
        },
      }).channels?.demo,
    ).toEqual({
      markdown: { tables: false },
    });
  });
});
