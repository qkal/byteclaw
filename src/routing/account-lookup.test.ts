import { describe, expect, it } from "vitest";
import { resolveAccountEntry, resolveNormalizedAccountEntry } from "./account-lookup.js";

function createAccountsWithPrototypePollution() {
  const inherited = { default: { id: "polluted" } };
  return Object.create(inherited) as Record<string, { id: string }>;
}

function expectResolvedAccountLookupCase(
  actual: { id: string } | undefined,
  expected: { id: string } | undefined,
) {
  expect(actual).toEqual(expected);
}

function expectPrototypePollutionIgnoredCase(
  resolve: (accounts: Record<string, { id: string }>) => { id: string } | undefined,
) {
  const pollutedAccounts = createAccountsWithPrototypePollution();
  expect(resolve(pollutedAccounts)).toBeUndefined();
}

function expectAccountLookupCase(params: {
  accounts?: Record<string, { id: string }>;
  resolve: (accounts: Record<string, { id: string }>) => { id: string } | undefined;
  expected: { id: string } | undefined;
}) {
  expectResolvedAccountLookupCase(params.resolve(params.accounts ?? {}), params.expected);
}

describe("resolveAccountEntry", () => {
  const accounts = {
    Business: { id: "business" },
    default: { id: "default" },
  };

  it.each([
    {
      expected: { id: "default" },
      name: "resolves the default account key",
      resolve: (localAccounts: Record<string, { id: string }>) =>
        resolveAccountEntry(localAccounts, "default"),
    },
    {
      expected: { id: "business" },
      name: "resolves a normalized business account key",
      resolve: (localAccounts: Record<string, { id: string }>) =>
        resolveAccountEntry(localAccounts, "business"),
    },
  ] as const)("$name", ({ resolve, expected }) => {
    expectAccountLookupCase({ accounts, expected, resolve });
  });

  it("ignores prototype-chain values", () => {
    expectPrototypePollutionIgnoredCase((localAccounts) =>
      resolveAccountEntry(localAccounts, "default"),
    );
  });
});

describe("resolveNormalizedAccountEntry", () => {
  const normalizeAccountId = (accountId: string) =>
    accountId.trim().toLowerCase().replaceAll(" ", "-");

  it.each([
    {
      accounts: {
        "Ops Team": { id: "ops" },
      },
      expected: {
        id: "ops",
      },
      name: "resolves normalized account keys with a custom normalizer",
      resolve: (accounts: Record<string, { id: string }>) =>
        resolveNormalizedAccountEntry(accounts, "ops-team", normalizeAccountId),
    },
    {
      assert: () =>
        expectPrototypePollutionIgnoredCase((accounts) =>
          resolveNormalizedAccountEntry(accounts, "default", (accountId) => accountId),
        ),
      expected: undefined,
      name: "ignores prototype-chain values",
      resolve: () => undefined,
    },
  ] as const)("$name", ({ accounts, resolve, expected, assert }) => {
    if (assert) {
      assert();
      return;
    }

    expectAccountLookupCase({
      accounts,
      expected,
      resolve,
    });
  });
});
