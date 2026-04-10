import { describe, expect, it } from "vitest";
import {
  buildDmGroupAccountAllowlistAdapter,
  buildLegacyDmAccountAllowlistAdapter,
  collectAllowlistOverridesFromRecord,
  collectNestedAllowlistOverridesFromRecord,
  createAccountScopedAllowlistNameResolver,
  createFlatAllowlistOverrideResolver,
  createNestedAllowlistOverrideResolver,
  readConfiguredAllowlistEntries,
} from "./allowlist-config-edit.js";

describe("readConfiguredAllowlistEntries", () => {
  it("coerces mixed entries to non-empty strings", () => {
    expect(readConfiguredAllowlistEntries(["owner", 42, ""])).toEqual(["owner", "42"]);
  });
});

describe("collectAllowlistOverridesFromRecord", () => {
  it.each([
    {
      expected: [{ entries: ["a", "b"], label: "room1" }],
      name: "collects only non-empty overrides from a flat record",
      record: {
        room1: { users: ["a", "b"] },
        room2: { users: [] },
      },
    },
  ])("$name", ({ record, expected }) => {
    expect(
      collectAllowlistOverridesFromRecord({
        label: (key) => key,
        record,
        resolveEntries: (value) => value.users,
      }),
    ).toEqual(expected);
  });
});

describe("collectNestedAllowlistOverridesFromRecord", () => {
  it.each([
    {
      expected: [
        { entries: ["owner"], label: "guild guild1" },
        { entries: ["member"], label: "guild guild1 / channel chan1" },
      ],
      name: "collects outer and nested overrides from a hierarchical record",
      record: {
        guild1: {
          channels: {
            chan1: { users: ["member"] },
          },
          users: ["owner"],
        },
      },
    },
  ])("$name", ({ record, expected }) => {
    expect(
      collectNestedAllowlistOverridesFromRecord({
        innerLabel: (outerKey, innerKey) => `guild ${outerKey} / channel ${innerKey}`,
        outerLabel: (key) => `guild ${key}`,
        record,
        resolveChildren: (value) => value.channels,
        resolveInnerEntries: (value) => value.users,
        resolveOuterEntries: (value) => value.users,
      }),
    ).toEqual(expected);
  });
});

describe("createFlatAllowlistOverrideResolver", () => {
  it.each([
    {
      account: { channels: { room1: { users: ["a"] } } },
      expected: [{ entries: ["a"], label: "room1" }],
      name: "builds an account-scoped flat override resolver",
    },
  ])("$name", ({ account, expected }) => {
    const resolveOverrides = createFlatAllowlistOverrideResolver({
      label: (key) => key,
      resolveEntries: (value) => value.users,
      resolveRecord: (account: { channels?: Record<string, { users: string[] }> }) =>
        account.channels,
    });

    expect(resolveOverrides(account)).toEqual(expected);
  });
});

describe("createNestedAllowlistOverrideResolver", () => {
  it.each([
    {
      account: {
        groups: {
          g1: { allowFrom: ["owner"], topics: { t1: { allowFrom: ["member"] } } },
        },
      },
      expected: [
        { entries: ["owner"], label: "g1" },
        { entries: ["member"], label: "g1 topic t1" },
      ],
      name: "builds an account-scoped nested override resolver",
    },
  ])("$name", ({ account, expected }) => {
    const resolveOverrides = createNestedAllowlistOverrideResolver({
      innerLabel: (groupId, topicId) => `${groupId} topic ${topicId}`,
      outerLabel: (groupId) => groupId,
      resolveChildren: (group) => group.topics,
      resolveInnerEntries: (topic) => topic.allowFrom,
      resolveOuterEntries: (group) => group.allowFrom,
      resolveRecord: (account: {
        groups?: Record<
          string,
          { allowFrom?: string[]; topics?: Record<string, { allowFrom?: string[] }> }
        >;
      }) => account.groups,
    });

    expect(resolveOverrides(account)).toEqual(expected);
  });
});

describe("createAccountScopedAllowlistNameResolver", () => {
  it.each([
    {
      expected: [],
      name: "returns empty results when the resolved account has no token",
      token: "",
    },
    {
      expected: [{ input: "a", name: "secret:a", resolved: true }],
      name: "delegates to the resolver when a token is present",
      token: " secret ",
    },
  ])("$name", async ({ token, expected }) => {
    const resolveNames = createAccountScopedAllowlistNameResolver({
      resolveAccount: () => ({ token }),
      resolveNames: async ({ token, entries }) =>
        entries.map((entry) => ({ input: entry, name: `${token}:${entry}`, resolved: true })),
      resolveToken: (account) => account.token,
    });

    expect(await resolveNames({ accountId: "alt", cfg: {}, entries: ["a"], scope: "dm" })).toEqual(
      expected,
    );
  });
});

describe("buildDmGroupAccountAllowlistAdapter", () => {
  const adapter = buildDmGroupAccountAllowlistAdapter({
    channelId: "demo",
    normalize: ({ values }) => values.map((entry) => String(entry).trim().toLowerCase()),
    resolveAccount: ({ accountId }) => ({
      accountId: accountId ?? "default",
      dmAllowFrom: ["dm-owner"],
      dmPolicy: "allowlist",
      groupAllowFrom: ["group-owner"],
      groupOverrides: [{ label: "room-1", entries: ["member-1"] }],
      groupPolicy: "allowlist",
    }),
    resolveDmAllowFrom: (account) => account.dmAllowFrom,
    resolveDmPolicy: (account) => account.dmPolicy,
    resolveGroupAllowFrom: (account) => account.groupAllowFrom,
    resolveGroupOverrides: (account) => account.groupOverrides,
    resolveGroupPolicy: (account) => account.groupPolicy,
  });

  const scopeCases: { scope: "dm" | "group" | "all"; expected: boolean }[] = [
    { expected: true, scope: "dm" },
    { expected: true, scope: "group" },
    { expected: true, scope: "all" },
  ];

  it.each(scopeCases)("supports $scope scope", ({ scope, expected }) => {
    expect(adapter.supportsScope?.({ scope })).toBe(expected);
  });

  it("reads dm/group config from the resolved account", () => {
    expect(adapter.readConfig?.({ accountId: "alt", cfg: {} })).toEqual({
      dmAllowFrom: ["dm-owner"],
      dmPolicy: "allowlist",
      groupAllowFrom: ["group-owner"],
      groupOverrides: [{ entries: ["member-1"], label: "room-1" }],
      groupPolicy: "allowlist",
    });
  });

  it("writes group allowlist entries to groupAllowFrom", () => {
    expect(
      adapter.applyConfigEdit?.({
        accountId: "alt",
        action: "add",
        cfg: {},
        entry: " Member-2 ",
        parsedConfig: {},
        scope: "group",
      }),
    ).toEqual({
      changed: true,
      kind: "ok",
      pathLabel: "channels.demo.accounts.alt.groupAllowFrom",
      writeTarget: {
        kind: "account",
        scope: { accountId: "alt", channelId: "demo" },
      },
    });
  });
});

describe("buildLegacyDmAccountAllowlistAdapter", () => {
  const adapter = buildLegacyDmAccountAllowlistAdapter({
    channelId: "demo",
    normalize: ({ values }) => values.map((entry) => String(entry).trim().toLowerCase()),
    resolveAccount: ({ accountId }) => ({
      accountId: accountId ?? "default",
      dmAllowFrom: ["owner"],
      groupOverrides: [{ label: "group-1", entries: ["member-1"] }],
      groupPolicy: "allowlist",
    }),
    resolveDmAllowFrom: (account) => account.dmAllowFrom,
    resolveGroupOverrides: (account) => account.groupOverrides,
    resolveGroupPolicy: (account) => account.groupPolicy,
  });

  const scopeCases: { scope: "dm" | "group" | "all"; expected: boolean }[] = [
    { expected: true, scope: "dm" },
    { expected: false, scope: "group" },
    { expected: false, scope: "all" },
  ];

  it.each(scopeCases)("supports $scope scope", ({ scope, expected }) => {
    expect(adapter.supportsScope?.({ scope })).toBe(expected);
  });

  it("reads legacy dm config from the resolved account", () => {
    expect(adapter.readConfig?.({ accountId: "alt", cfg: {} })).toEqual({
      dmAllowFrom: ["owner"],
      groupOverrides: [{ entries: ["member-1"], label: "group-1" }],
      groupPolicy: "allowlist",
    });
  });

  it("writes dm allowlist entries and keeps legacy cleanup behavior", () => {
    expect(
      adapter.applyConfigEdit?.({
        accountId: "alt",
        action: "add",
        cfg: {},
        entry: "admin",
        parsedConfig: {
          channels: {
            demo: {
              accounts: {
                alt: {
                  dm: { allowFrom: ["owner"] },
                },
              },
            },
          },
        },
        scope: "dm",
      }),
    ).toEqual({
      changed: true,
      kind: "ok",
      pathLabel: "channels.demo.accounts.alt.allowFrom",
      writeTarget: {
        kind: "account",
        scope: { accountId: "alt", channelId: "demo" },
      },
    });
  });
});
