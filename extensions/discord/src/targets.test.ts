import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDiscordDirectoryCacheForTest,
  resolveDiscordDirectoryUserId,
} from "./directory-cache.js";
import * as directoryLive from "./directory-live.js";
import {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./group-policy.js";
import { normalizeDiscordMessagingTarget } from "./normalize.js";
import { parseDiscordTarget, resolveDiscordChannelId, resolveDiscordTarget } from "./targets.js";

describe("parseDiscordTarget", () => {
  it("parses user mention and prefixes", () => {
    const cases = [
      { id: "123", input: "<@123>", normalized: "user:123" },
      { id: "456", input: "<@!456>", normalized: "user:456" },
      { id: "789", input: "user:789", normalized: "user:789" },
      { id: "987", input: "discord:987", normalized: "user:987" },
    ] as const;
    for (const testCase of cases) {
      expect(parseDiscordTarget(testCase.input), testCase.input).toMatchObject({
        id: testCase.id,
        kind: "user",
        normalized: testCase.normalized,
      });
    }
  });

  it("parses channel targets", () => {
    const cases = [
      { id: "555", input: "channel:555", normalized: "channel:555" },
      { id: "general", input: "general", normalized: "channel:general" },
    ] as const;
    for (const testCase of cases) {
      expect(parseDiscordTarget(testCase.input), testCase.input).toMatchObject({
        id: testCase.id,
        kind: "channel",
        normalized: testCase.normalized,
      });
    }
  });

  it("accepts numeric ids when a default kind is provided", () => {
    expect(parseDiscordTarget("123", { defaultKind: "channel" })).toMatchObject({
      id: "123",
      kind: "channel",
      normalized: "channel:123",
    });
  });

  it("rejects invalid parse targets", () => {
    const cases = [
      { expectedMessage: /Ambiguous Discord recipient/, input: "123" },
      { expectedMessage: /Discord DMs require a user id/, input: "@bob" },
    ] as const;
    for (const testCase of cases) {
      expect(() => parseDiscordTarget(testCase.input), testCase.input).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});

describe("resolveDiscordChannelId", () => {
  it("strips channel: prefix and accepts raw ids", () => {
    expect(resolveDiscordChannelId("channel:123")).toBe("123");
    expect(resolveDiscordChannelId("123")).toBe("123");
  });

  it("rejects user targets", () => {
    expect(() => resolveDiscordChannelId("user:123")).toThrow(/channel id is required/i);
  });
});

describe("resolveDiscordTarget", () => {
  const cfg = { channels: { discord: {} } } as OpenClawConfig;

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetDiscordDirectoryCacheForTest();
  });

  it("returns a resolved user for usernames", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { id: "user:999", kind: "user", name: "Jane" } as const,
    ]);

    await expect(
      resolveDiscordTarget("jane", { accountId: "default", cfg }),
    ).resolves.toMatchObject({ id: "999", kind: "user", normalized: "user:999" });
  });

  it("falls back to parsing when lookup misses", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([]);
    await expect(
      resolveDiscordTarget("general", { accountId: "default", cfg }),
    ).resolves.toMatchObject({ id: "general", kind: "channel" });
  });

  it("does not call directory lookup for explicit user ids", async () => {
    const listPeers = vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive");
    await expect(
      resolveDiscordTarget("user:123", { accountId: "default", cfg }),
    ).resolves.toMatchObject({ id: "123", kind: "user" });
    expect(listPeers).not.toHaveBeenCalled();
  });

  it("caches username lookups under the configured default account when accountId is omitted", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            work: {
              token: "discord-work",
            },
          },
          defaultAccount: "work",
        },
      },
    } as OpenClawConfig;

    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { id: "user:999", kind: "user", name: "Jane" } as const,
    ]);

    await expect(resolveDiscordTarget("jane", { cfg })).resolves.toMatchObject({
      id: "999",
      kind: "user",
      normalized: "user:999",
    });
    expect(resolveDiscordDirectoryUserId({ accountId: "work", handle: "jane" })).toBe("999");
    expect(resolveDiscordDirectoryUserId({ accountId: "default", handle: "jane" })).toBeUndefined();
  });
});

describe("normalizeDiscordMessagingTarget", () => {
  it("defaults raw numeric ids to channels", () => {
    expect(normalizeDiscordMessagingTarget("123")).toBe("channel:123");
  });
});

describe("discord group policy", () => {
  it("prefers channel policy, then guild policy, with sender-specific overrides", () => {
    const discordCfg = {
      channels: {
        discord: {
          guilds: {
            guild1: {
              channels: {
                "123": {
                  requireMention: true,
                  tools: { allow: ["message.channel"] },
                  toolsBySender: {
                    "id:user:channel-admin": { deny: ["exec"] },
                  },
                },
              },
              requireMention: false,
              tools: { allow: ["message.guild"] },
              toolsBySender: {
                "id:user:guild-admin": { allow: ["sessions.list"] },
              },
            },
          },
          token: "discord-test",
        },
      },
    } as any;

    expect(
      resolveDiscordGroupRequireMention({ cfg: discordCfg, groupId: "123", groupSpace: "guild1" }),
    ).toBe(true);
    expect(
      resolveDiscordGroupRequireMention({
        cfg: discordCfg,
        groupId: "missing",
        groupSpace: "guild1",
      }),
    ).toBe(false);
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupId: "123",
        groupSpace: "guild1",
        senderId: "user:channel-admin",
      }),
    ).toEqual({ deny: ["exec"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupId: "123",
        groupSpace: "guild1",
        senderId: "user:someone",
      }),
    ).toEqual({ allow: ["message.channel"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupId: "missing",
        groupSpace: "guild1",
        senderId: "user:guild-admin",
      }),
    ).toEqual({ allow: ["sessions.list"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupId: "missing",
        groupSpace: "guild1",
        senderId: "user:someone",
      }),
    ).toEqual({ allow: ["message.guild"] });
  });

  it("honors account-scoped guild and channel overrides", () => {
    const discordCfg = {
      channels: {
        discord: {
          accounts: {
            work: {
              guilds: {
                guild1: {
                  channels: {
                    "123": {
                      requireMention: true,
                      tools: { allow: ["message.account-channel"] },
                    },
                  },
                  requireMention: false,
                  tools: { allow: ["message.account"] },
                },
              },
              token: "discord-work",
            },
          },
          guilds: {
            guild1: {
              requireMention: true,
              tools: { allow: ["message.root"] },
            },
          },
          token: "discord-test",
        },
      },
    } as any;

    expect(
      resolveDiscordGroupRequireMention({
        accountId: "work",
        cfg: discordCfg,
        groupId: "missing",
        groupSpace: "guild1",
      }),
    ).toBe(false);
    expect(
      resolveDiscordGroupRequireMention({
        accountId: "work",
        cfg: discordCfg,
        groupId: "123",
        groupSpace: "guild1",
      }),
    ).toBe(true);
    expect(
      resolveDiscordGroupToolPolicy({
        accountId: "work",
        cfg: discordCfg,
        groupId: "missing",
        groupSpace: "guild1",
      }),
    ).toEqual({ allow: ["message.account"] });
    expect(
      resolveDiscordGroupToolPolicy({
        accountId: "work",
        cfg: discordCfg,
        groupId: "123",
        groupSpace: "guild1",
      }),
    ).toEqual({ allow: ["message.account-channel"] });
  });
});
