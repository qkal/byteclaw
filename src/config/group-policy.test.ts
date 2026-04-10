import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { resolveChannelGroupPolicy, resolveToolsBySender } from "./group-policy.js";

describe("resolveChannelGroupPolicy", () => {
  it("fails closed when groupPolicy=allowlist and groups are missing", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(false);
  });

  it("allows configured groups when groupPolicy=allowlist", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groups: {
            "123@g.us": { requireMention: true },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(true);
  });

  it("blocks all groups when groupPolicy=disabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "disabled",
          groups: {
            "*": { requireMention: false },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
    });

    expect(policy.allowed).toBe(false);
  });

  it("respects account-scoped groupPolicy overrides", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              groupPolicy: "allowlist",
            },
          },
          groupPolicy: "open",
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      accountId: "work",
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(false);
  });

  it("allows groups when groupPolicy=allowlist with hasGroupAllowFrom but no groups", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
      hasGroupAllowFrom: true,
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(true);
  });

  it("still fails closed when groupPolicy=allowlist without groups or groupAllowFrom", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
      hasGroupAllowFrom: false,
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(false);
  });
});

describe("resolveToolsBySender", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches typed sender IDs", () => {
    expect(
      resolveToolsBySender({
        senderId: "user:alice",
        toolsBySender: {
          "*": { deny: ["exec"] },
          "id:user:alice": { allow: ["exec"] },
        },
      }),
    ).toEqual({ allow: ["exec"] });
  });

  it("does not allow senderName collisions to match id keys", () => {
    const victimId = "f4ce8a7d-1111-2222-3333-444455556666";
    expect(
      resolveToolsBySender({
        senderId: "attacker-real-id",
        senderName: victimId,
        senderUsername: "attacker",
        toolsBySender: {
          [`id:${victimId}`]: { allow: ["exec", "fs.read"] },
          "*": { deny: ["exec"] },
        },
      }),
    ).toEqual({ deny: ["exec"] });
  });

  it("treats untyped legacy keys as senderId only", () => {
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const victimId = "legacy-owner-id";
    expect(
      resolveToolsBySender({
        senderId: "attacker-real-id",
        senderName: victimId,
        toolsBySender: {
          [victimId]: { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
      }),
    ).toEqual({ deny: ["exec"] });

    expect(
      resolveToolsBySender({
        senderId: victimId,
        senderName: "attacker",
        toolsBySender: {
          [victimId]: { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
      }),
    ).toEqual({ allow: ["exec"] });
    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it("matches username keys only against senderUsername", () => {
    expect(
      resolveToolsBySender({
        senderId: "alice",
        senderUsername: "other-user",
        toolsBySender: {
          "*": { deny: ["exec"] },
          "username:alice": { allow: ["exec"] },
        },
      }),
    ).toEqual({ deny: ["exec"] });

    expect(
      resolveToolsBySender({
        senderId: "other-id",
        senderUsername: "@alice",
        toolsBySender: {
          "*": { deny: ["exec"] },
          "username:alice": { allow: ["exec"] },
        },
      }),
    ).toEqual({ allow: ["exec"] });
  });

  it("matches e164 and name only when explicitly typed", () => {
    expect(
      resolveToolsBySender({
        senderE164: "+15550001111",
        senderName: "owner",
        toolsBySender: {
          "e164:+15550001111": { allow: ["exec"] },
          "name:owner": { deny: ["exec"] },
        },
      }),
    ).toEqual({ allow: ["exec"] });
  });

  it("prefers id over username over name", () => {
    expect(
      resolveToolsBySender({
        senderId: "alice",
        senderName: "alice",
        senderUsername: "alice",
        toolsBySender: {
          "id:alice": { deny: ["exec"] },
          "name:alice": { allow: ["read"] },
          "username:alice": { allow: ["exec"] },
        },
      }),
    ).toEqual({ deny: ["exec"] });
  });

  it("emits one deprecation warning per legacy key", () => {
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const legacyKey = "legacy-warning-key";
    const policy = {
      [legacyKey]: { allow: ["exec"] },
      "*": { deny: ["exec"] },
    };

    resolveToolsBySender({
      senderId: "other-id",
      toolsBySender: policy,
    });
    resolveToolsBySender({
      senderId: "other-id",
      toolsBySender: policy,
    });

    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(String(warningSpy.mock.calls[0]?.[0])).toContain(`toolsBySender key "${legacyKey}"`);
    expect(warningSpy.mock.calls[0]?.[1]).toMatchObject({
      code: "OPENCLAW_TOOLS_BY_SENDER_UNTYPED_KEY",
    });
  });
});
