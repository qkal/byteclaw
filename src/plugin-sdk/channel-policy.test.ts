import { describe, expect, it } from "vitest";
import { formatPairingApproveHint } from "../channels/plugins/helpers.js";
import type { GroupPolicy } from "../config/types.base.js";
import {
  coerceNativeSetting,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
  createRestrictSendersChannelSecurity,
  normalizeAllowFromList,
} from "./channel-policy.js";

describe("createRestrictSendersChannelSecurity", () => {
  it("builds dm policy resolution and open-group warnings from one descriptor", async () => {
    const security = createRestrictSendersChannelSecurity<{
      accountId: string;
      allowFrom?: string[];
      dmPolicy?: string;
      groupPolicy?: GroupPolicy;
    }>({
      channelKey: "line",
      groupAllowFromPath: "channels.line.groupAllowFrom",
      groupPolicyPath: "channels.line.groupPolicy",
      mentionGated: false,
      openScope: "any member in groups",
      policyPathSuffix: "dmPolicy",
      resolveDmAllowFrom: (account) => account.allowFrom,
      resolveDmPolicy: (account) => account.dmPolicy,
      resolveGroupPolicy: (account) => account.groupPolicy,
      surface: "LINE groups",
    });

    expect(
      security.resolveDmPolicy?.({
        account: {
          accountId: "default",
          allowFrom: ["line:user:abc"],
          dmPolicy: "allowlist",
        },
        accountId: "default",
        cfg: { channels: {} } as never,
      }),
    ).toEqual({
      allowFrom: ["line:user:abc"],
      allowFromPath: "channels.line.",
      approveHint: formatPairingApproveHint("line"),
      normalizeEntry: undefined,
      policy: "allowlist",
      policyPath: "channels.line.dmPolicy",
    });

    expect(
      security.collectWarnings?.({
        account: {
          accountId: "default",
          groupPolicy: "open",
        },
        accountId: "default",
        cfg: { channels: { line: {} } } as never,
      }),
    ).toEqual([
      '- LINE groups: groupPolicy="open" allows any member in groups to trigger. Set channels.line.groupPolicy="allowlist" + channels.line.groupAllowFrom to restrict senders.',
    ]);
  });
});

describe("createDangerousNameMatchingMutableAllowlistWarningCollector", () => {
  const collectWarnings = createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "irc",
    collectLists: (scope) => [
      {
        list: scope.account.allowFrom,
        pathLabel: `${scope.prefix}.allowFrom`,
      },
    ],
    detector: (entry) => !entry.includes("@"),
  });

  it("collects mutable entries while dangerous matching is disabled", () => {
    expect(
      collectWarnings({
        cfg: {
          channels: {
            irc: {
              allowFrom: ["charlie"],
            },
          },
        } as never,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mutable allowlist entry"),
        expect.stringContaining("channels.irc.allowFrom: charlie"),
      ]),
    );
  });

  it("skips scopes that explicitly allow dangerous name matching", () => {
    expect(
      collectWarnings({
        cfg: {
          channels: {
            irc: {
              allowFrom: ["charlie"],
              dangerouslyAllowNameMatching: true,
            },
          },
        } as never,
      }),
    ).toEqual([]);
  });
});

describe("normalizeAllowFromList", () => {
  it("normalizes strings and numbers into trimmed entries", () => {
    expect(normalizeAllowFromList(["  abc ", 42, "", "   "])).toEqual(["abc", "42"]);
  });

  it("returns an empty list for non-arrays", () => {
    expect(normalizeAllowFromList(undefined)).toEqual([]);
    expect(normalizeAllowFromList(null)).toEqual([]);
  });
});

describe("coerceNativeSetting", () => {
  it("keeps boolean and auto values", () => {
    expect(coerceNativeSetting(true)).toBe(true);
    expect(coerceNativeSetting(false)).toBe(false);
    expect(coerceNativeSetting("auto")).toBe("auto");
  });

  it("drops unsupported values", () => {
    expect(coerceNativeSetting("true")).toBeUndefined();
    expect(coerceNativeSetting("on")).toBeUndefined();
    expect(coerceNativeSetting(1)).toBeUndefined();
  });
});
