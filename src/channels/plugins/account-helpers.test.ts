import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  createAccountListHelpers,
  describeAccountSnapshot,
  describeWebhookAccountSnapshot,
  listCombinedAccountIds,
  mergeAccountConfig,
  resolveListedDefaultAccountId,
  resolveMergedAccountConfig,
} from "./account-helpers.js";

const { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId } =
  createAccountListHelpers("testchannel");

function cfg(accounts?: Record<string, unknown> | null, defaultAccount?: string): OpenClawConfig {
  if (accounts === null) {
    return {
      channels: {
        testchannel: defaultAccount ? { defaultAccount } : {},
      },
    } as unknown as OpenClawConfig;
  }
  if (accounts === undefined && !defaultAccount) {
    return {} as unknown as OpenClawConfig;
  }
  return {
    channels: {
      testchannel: {
        ...(accounts === undefined ? {} : { accounts }),
        ...(defaultAccount ? { defaultAccount } : {}),
      },
    },
  } as unknown as OpenClawConfig;
}

function expectResolvedAccountIdsCase(params: {
  resolve: (cfg: OpenClawConfig) => string[];
  input: OpenClawConfig;
  expected: string[];
}) {
  expect(params.resolve(params.input)).toEqual(params.expected);
}

function expectResolvedDefaultAccountCase(input: OpenClawConfig, expected: string) {
  expect(resolveDefaultAccountId(input)).toBe(expected);
}

describe("createAccountListHelpers", () => {
  describe("listConfiguredAccountIds", () => {
    it.each([
      {
        input: {} as OpenClawConfig,
        name: "returns empty for missing config",
      },
      {
        input: cfg(null),
        name: "returns empty when no accounts key",
      },
      {
        input: cfg({}),
        name: "returns empty for empty accounts object",
      },
    ])("$name", ({ input }) => {
      expectResolvedAccountIdsCase({
        expected: [],
        input,
        resolve: listConfiguredAccountIds,
      });
    });

    it("filters out empty keys", () => {
      expect(listConfiguredAccountIds(cfg({ "": {}, a: {} }))).toEqual(["a"]);
    });

    it("returns account keys", () => {
      expect(listConfiguredAccountIds(cfg({ personal: {}, work: {} }))).toEqual([
        "work",
        "personal",
      ]);
    });
  });

  describe("with normalizeAccountId option", () => {
    const normalized = createAccountListHelpers("testchannel", { normalizeAccountId });

    it("normalizes and deduplicates configured account ids", () => {
      expect(
        normalized.listConfiguredAccountIds(
          cfg({
            "Personal A": {},
            "Router D": {},
            "router-d": {},
          }),
        ),
      ).toEqual(["router-d", "personal-a"]);
    });
  });

  describe("listAccountIds", () => {
    it.each([
      {
        expected: ["default"],
        input: {} as OpenClawConfig,
        name: 'returns ["default"] for empty config',
      },
      {
        expected: ["default"],
        input: cfg({}),
        name: 'returns ["default"] for empty accounts',
      },
      {
        expected: ["a", "m", "z"],
        input: cfg({ a: {}, m: {}, z: {} }),
        name: "returns sorted ids",
      },
    ])("$name", ({ input, expected }) => {
      expectResolvedAccountIdsCase({
        expected,
        input,
        resolve: listAccountIds,
      });
    });
  });

  describe("resolveDefaultAccountId", () => {
    it.each([
      {
        expected: "beta",
        input: cfg({ alpha: {}, beta: {} }, "beta"),
        name: "prefers configured defaultAccount when it matches a configured account id",
      },
      {
        expected: "router-d",
        input: cfg({ "router-d": {} }, "Router D"),
        name: "normalizes configured defaultAccount before matching",
      },
      {
        expected: "alpha",
        input: cfg({ alpha: {}, beta: {} }, "missing"),
        name: "falls back when configured defaultAccount is missing",
      },
      {
        expected: "default",
        input: cfg({ default: {}, other: {} }),
        name: 'returns "default" when present',
      },
      {
        expected: "alpha",
        input: cfg({ alpha: {}, beta: {} }),
        name: "returns first sorted id when no default",
      },
      {
        expected: "default",
        input: {} as OpenClawConfig,
        name: 'returns "default" for empty config',
      },
    ])("$name", ({ input, expected }) => {
      expectResolvedDefaultAccountCase(input, expected);
    });

    it("can preserve configured defaults that are not present in accounts", () => {
      const preserveDefault = createAccountListHelpers("testchannel", {
        allowUnlistedDefaultAccount: true,
      });

      expect(preserveDefault.resolveDefaultAccountId(cfg({ default: {}, zeta: {} }, "ops"))).toBe(
        "ops",
      );
    });
  });
});

describe("listCombinedAccountIds", () => {
  it("combines configured, additional, and implicit ids once", () => {
    expect(
      listCombinedAccountIds({
        additionalAccountIds: ["default", "alerts"],
        configuredAccountIds: ["work", "alerts"],
        implicitAccountId: "ops",
      }),
    ).toEqual(["alerts", "default", "ops", "work"]);
  });

  it("uses the fallback id when no accounts are present", () => {
    expect(
      listCombinedAccountIds({
        configuredAccountIds: [],
        fallbackAccountIdWhenEmpty: "default",
      }),
    ).toEqual(["default"]);
  });
});

describe("resolveListedDefaultAccountId", () => {
  it.each([
    {
      expected: "work",
      input: {
        accountIds: ["alerts", "work"],
        configuredDefaultAccountId: "work",
      },
      name: "prefers the configured default when present in the listed ids",
    },
    {
      expected: "router-d",
      input: {
        accountIds: ["Router D"],
        configuredDefaultAccountId: "router-d",
      },
      name: "matches configured defaults against normalized listed ids",
    },
    {
      expected: "default",
      input: {
        accountIds: ["default", "work"],
      },
      name: "prefers the default account id when listed",
    },
    {
      expected: "ops",
      input: {
        accountIds: ["default", "work"],
        allowUnlistedDefaultAccount: true,
        configuredDefaultAccountId: "ops",
      },
      name: "can preserve an unlisted configured default",
    },
    {
      expected: "default",
      input: {
        accountIds: ["alerts", "work"],
        ambiguousFallbackAccountId: "default",
      },
      name: "supports an explicit fallback id for ambiguous multi-account setups",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveListedDefaultAccountId(input)).toBe(expected);
  });
});

describe("describeAccountSnapshot", () => {
  it("builds the standard snapshot shape with optional extras", () => {
    expect(
      describeAccountSnapshot({
        account: {
          accountId: "work",
          enabled: true,
          name: "Work",
        },
        configured: true,
        extra: {
          tokenSource: "config",
        },
      }),
    ).toEqual({
      accountId: "work",
      configured: true,
      enabled: true,
      name: "Work",
      tokenSource: "config",
    });
  });

  it("normalizes missing identity fields to the shared defaults", () => {
    expect(
      describeAccountSnapshot({
        account: {},
      }),
    ).toEqual({
      accountId: "default",
      configured: undefined,
      enabled: true,
      name: undefined,
    });
  });
});

describe("describeWebhookAccountSnapshot", () => {
  it("defaults mode to webhook while preserving caller extras", () => {
    expect(
      describeWebhookAccountSnapshot({
        account: {
          accountId: "work",
          name: "Work",
        },
        configured: true,
        extra: {
          tokenSource: "config",
        },
      }),
    ).toEqual({
      accountId: "work",
      configured: true,
      enabled: true,
      mode: "webhook",
      name: "Work",
      tokenSource: "config",
    });
  });

  it("allows callers to override the mode when the transport is not always webhook", () => {
    expect(
      describeWebhookAccountSnapshot({
        account: {
          accountId: "work",
        },
        mode: "polling",
      }),
    ).toEqual({
      accountId: "work",
      configured: undefined,
      enabled: true,
      mode: "polling",
      name: undefined,
    });
  });
});

describe("mergeAccountConfig", () => {
  interface MergeAccountConfigShape {
    enabled?: boolean;
    defaultAccount?: string;
    name?: string;
    accounts?: Record<string, { name: string }>;
    commands?: {
      native?: boolean;
      callbackPath?: string;
    };
  }

  type MergeAccountInput = Parameters<typeof mergeAccountConfig<MergeAccountConfigShape>>[0];

  it.each([
    {
      expected: {
        enabled: true,
        name: "Work",
      },
      input: {
        accountConfig: {
          name: "Work",
        },
        channelConfig: {
          accounts: {
            work: { name: "Work" },
          },
          enabled: true,
        },
      },
      name: "drops accounts from the base config before merging",
    },
    {
      expected: {
        enabled: true,
        name: "Work",
      },
      input: {
        accountConfig: {
          name: "Work",
        },
        channelConfig: {
          defaultAccount: "work",
          enabled: true,
        },
        omitKeys: ["defaultAccount"],
      },
      name: "drops caller-specified keys from the base config before merging",
    },
    {
      expected: {
        commands: {
          callbackPath: "/work",
          native: true,
        },
      },
      input: {
        accountConfig: {
          commands: {
            callbackPath: "/work",
          },
        },
        channelConfig: {
          commands: {
            native: true,
          },
        },
        nestedObjectKeys: ["commands"],
      },
      name: "deep-merges selected nested object keys",
    },
  ] satisfies {
    name: string;
    input: MergeAccountInput;
    expected: MergeAccountConfigShape;
  }[])("$name", ({ input, expected }) => {
    expect(mergeAccountConfig<MergeAccountConfigShape>(input)).toEqual(expected);
  });
});

describe("resolveMergedAccountConfig", () => {
  interface MergedChannelConfig {
    enabled?: boolean;
    name?: string;
  }

  type ResolveMergedInput = Parameters<typeof resolveMergedAccountConfig<MergedChannelConfig>>[0];

  const resolveMergedCases: {
    name: string;
    input: ResolveMergedInput;
    expected: MergedChannelConfig;
  }[] = [
    {
      expected: {
        enabled: true,
        name: "Work",
      },
      input: {
        accountId: "work",
        accounts: {
          work: {
            name: "Work",
          },
        },
        channelConfig: {
          enabled: true,
        },
      },
      name: "merges the matching account config into channel config",
    },
    {
      expected: {
        enabled: true,
        name: "Router",
      },
      input: {
        accountId: "router-d",
        accounts: {
          "Router D": {
            name: "Router",
          },
        },
        channelConfig: {
          enabled: true,
        },
        normalizeAccountId,
      },
      name: "supports normalized account lookups",
    },
  ];

  it.each(resolveMergedCases)("$name", ({ input, expected }) => {
    expect(resolveMergedAccountConfig<MergedChannelConfig>(input)).toEqual(expected);
  });

  it("deep-merges selected nested object keys after resolving the account", () => {
    const merged = resolveMergedAccountConfig<{
      nickserv?: { service?: string; registerEmail?: string };
    }>({
      accountId: "work",
      accounts: {
        work: {
          nickserv: {
            registerEmail: "work@example.com",
          },
        },
      },
      channelConfig: {
        nickserv: {
          service: "NickServ",
        },
      },
      nestedObjectKeys: ["nickserv"],
    });

    expect(merged).toEqual({
      nickserv: {
        registerEmail: "work@example.com",
        service: "NickServ",
      },
    });
  });
});
