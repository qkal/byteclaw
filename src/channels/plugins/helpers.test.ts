import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildAccountScopedDmSecurityPolicy,
  formatPairingApproveHint,
  parseOptionalDelimitedEntries,
} from "./helpers.js";

function cfgWithChannel(channelKey: string, accounts?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      [channelKey]: accounts ? { accounts } : {},
    },
  } as unknown as OpenClawConfig;
}

describe("buildAccountScopedDmSecurityPolicy", () => {
  it.each([
    {
      expected: {
        allowFrom: ["123"],
        allowFromPath: "channels.demo-root.",
        approveHint: formatPairingApproveHint("demo-root"),
        normalizeEntry: undefined,
        policy: "pairing",
        policyPath: "channels.demo-root.dmPolicy",
      },
      input: {
        allowFrom: ["123"],
        cfg: cfgWithChannel("demo-root"),
        channelKey: "demo-root",
        fallbackAccountId: "default",
        policy: "pairing",
        policyPathSuffix: "dmPolicy",
      },
      name: "builds top-level dm policy paths when no account config exists",
    },
    {
      expected: {
        allowFrom: ["+12125551212"],
        allowFromPath: "channels.demo-account.accounts.work.",
        approveHint: formatPairingApproveHint("demo-account"),
        normalizeEntry: undefined,
        policy: "allowlist",
        policyPath: "channels.demo-account.accounts.work.dmPolicy",
      },
      input: {
        accountId: "work",
        allowFrom: ["+12125551212"],
        cfg: cfgWithChannel("demo-account", { work: {} }),
        channelKey: "demo-account",
        fallbackAccountId: "default",
        policy: "allowlist",
        policyPathSuffix: "dmPolicy",
      },
      name: "uses account-scoped paths when account config exists",
    },
    {
      expected: {
        allowFrom: [],
        allowFromPath: "channels.demo-nested.accounts.work.dm.",
        approveHint: formatPairingApproveHint("demo-nested"),
        normalizeEntry: undefined,
        policy: "pairing",
        policyPath: undefined,
      },
      input: {
        accountId: "work",
        allowFrom: [],
        allowFromPathSuffix: "dm.",
        cfg: cfgWithChannel("demo-nested", { work: {} }),
        channelKey: "demo-nested",
        policy: "pairing",
      },
      name: "supports nested dm paths without explicit policyPath",
    },
    {
      expected: {
        allowFrom: ["user-1"],
        allowFromPath: "channels.demo-default.",
        approveHint: "openclaw pairing approve demo-default <code>",
        normalizeEntry: undefined,
        policy: "allowlist",
        policyPath: "channels.demo-default.dmPolicy",
      },
      input: {
        allowFrom: ["user-1"],
        approveHint: "openclaw pairing approve demo-default <code>",
        cfg: cfgWithChannel("demo-default"),
        channelKey: "demo-default",
        defaultPolicy: "allowlist",
        fallbackAccountId: "default",
        policyPathSuffix: "dmPolicy",
      },
      name: "supports custom defaults and approve hints",
    },
  ])("$name", ({ input, expected }) => {
    expect(buildAccountScopedDmSecurityPolicy(input)).toEqual(expected);
  });
});

describe("parseOptionalDelimitedEntries", () => {
  it("returns undefined for empty input", () => {
    expect(parseOptionalDelimitedEntries("  ")).toBeUndefined();
  });

  it("splits comma, newline, and semicolon separated entries", () => {
    expect(parseOptionalDelimitedEntries("alpha, beta\ngamma; delta")).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });
});
