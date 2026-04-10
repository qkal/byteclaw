import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it } from "vitest";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { createSlackMonitorContext, normalizeSlackChannelType } from "./context.js";

describe("resolveSlackChannelConfig", () => {
  it("uses defaultRequireMention when channels config is empty", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {},
      defaultRequireMention: false,
    });
    expect(res).toEqual({ allowed: true, requireMention: false });
  });

  it("defaults defaultRequireMention to true when not provided", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {},
    });
    expect(res).toEqual({ allowed: true, requireMention: true });
  });

  it("prefers explicit channel/fallback requireMention over defaultRequireMention", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { "*": { requireMention: true } },
      defaultRequireMention: false,
    });
    expect(res).toMatchObject({ requireMention: true });
  });

  it("uses wildcard entries when no direct channel config exists", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { "*": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({
      allowed: true,
      matchKey: "*",
      matchSource: "wildcard",
      requireMention: false,
    });
  });

  it("uses direct match metadata when channel config exists", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { C1: { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({
      matchKey: "C1",
      matchSource: "direct",
    });
  });

  it("matches channel config key stored in lowercase when Slack delivers uppercase channel ID", () => {
    // Slack always delivers channel IDs in uppercase (e.g. C0ABC12345).
    // Users commonly copy them in lowercase from docs or older CLI output.
    const res = resolveSlackChannelConfig({
      channelId: "C0ABC12345", // Pragma: allowlist secret
      channels: { c0abc12345: { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({ allowed: true, requireMention: false });
  });

  it("matches channel config key stored in uppercase when user types lowercase channel ID", () => {
    // Defensive: also handle the inverse direction.
    const res = resolveSlackChannelConfig({
      channelId: "c0abc12345", // Pragma: allowlist secret
      channels: { C0ABC12345: { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({ allowed: true, requireMention: false });
  });

  it("blocks channel-name route matches by default", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channelName: "ops-room",
      channels: { "ops-room": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({ allowed: false, requireMention: true });
  });

  it("allows channel-name route matches when dangerous name matching is enabled", () => {
    const res = resolveSlackChannelConfig({
      allowNameMatching: true,
      channelId: "C1",
      channelName: "ops-room",
      channels: { "ops-room": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({
      allowed: true,
      matchKey: "ops-room",
      matchSource: "direct",
      requireMention: false,
    });
  });
});

const baseParams = () => ({
  accountId: "default",
  ackReactionScope: "group-mentions",
  allowFrom: [],
  allowNameMatching: false,
  apiAppId: "A1",
  app: { client: {} } as App,
  botToken: "token",
  botUserId: "B1",
  cfg: {} as OpenClawConfig,
  defaultRequireMention: true,
  dmEnabled: true,
  dmPolicy: "open" as const,
  groupDmChannels: [],
  groupDmEnabled: true,
  groupPolicy: "open" as const,
  historyLimit: 0,
  mainKey: "main",
  mediaMaxBytes: 1,
  reactionAllowlist: [],
  reactionMode: "off" as const,
  removeAckAfterReply: false,
  replyToMode: "off" as const,
  runtime: {} as RuntimeEnv,
  sessionScope: "per-sender" as const,
  slashCommand: {
    enabled: false,
    ephemeral: true,
    name: "openclaw",
    sessionPrefix: "slack:slash",
  },
  teamId: "T1",
  textLimit: 4000,
  threadHistoryScope: "thread" as const,
  threadInheritParent: false,
  threadRequireExplicitMention: false,
  typingReaction: "",
  useAccessGroups: false,
});

function createListedChannelsContext(groupPolicy: "open" | "allowlist") {
  return createSlackMonitorContext({
    ...baseParams(),
    channelsConfig: {
      C_LISTED: { requireMention: true },
    },
    groupPolicy,
  });
}

describe("normalizeSlackChannelType", () => {
  it("infers channel types from ids when missing", () => {
    expect(normalizeSlackChannelType(undefined, "C123")).toBe("channel");
    expect(normalizeSlackChannelType(undefined, "D123")).toBe("im");
    expect(normalizeSlackChannelType(undefined, "G123")).toBe("group");
  });

  it("prefers explicit channel_type values", () => {
    expect(normalizeSlackChannelType("mpim", "C123")).toBe("mpim");
  });

  it("overrides wrong channel_type for D-prefix DM channels", () => {
    // Slack DM channel IDs always start with "D" — if the event
    // Reports a wrong channel_type, the D-prefix should win.
    expect(normalizeSlackChannelType("channel", "D123")).toBe("im");
    expect(normalizeSlackChannelType("group", "D456")).toBe("im");
    expect(normalizeSlackChannelType("mpim", "D789")).toBe("im");
  });

  it("preserves correct channel_type for D-prefix DM channels", () => {
    expect(normalizeSlackChannelType("im", "D123")).toBe("im");
  });

  it("does not override G-prefix channel_type (ambiguous prefix)", () => {
    // G-prefix can be either "group" (private channel) or "mpim" (group DM)
    // — trust the provided channel_type since the prefix is ambiguous.
    expect(normalizeSlackChannelType("group", "G123")).toBe("group");
    expect(normalizeSlackChannelType("mpim", "G456")).toBe("mpim");
  });
});

describe("resolveSlackSystemEventSessionKey", () => {
  it("defaults missing channel_type to channel sessions", () => {
    const ctx = createSlackMonitorContext(baseParams());
    expect(ctx.resolveSlackSystemEventSessionKey({ channelId: "C123" })).toBe(
      "agent:main:slack:channel:c123",
    );
  });

  it("routes channel system events through account bindings", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      accountId: "work",
      cfg: {
        bindings: [
          {
            agentId: "ops",
            match: {
              accountId: "work",
              channel: "slack",
            },
          },
        ],
      },
    });
    expect(
      ctx.resolveSlackSystemEventSessionKey({ channelId: "C123", channelType: "channel" }),
    ).toBe("agent:ops:slack:channel:c123");
  });

  it("routes DM system events through direct-peer bindings when sender is known", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      accountId: "work",
      cfg: {
        bindings: [
          {
            agentId: "ops-dm",
            match: {
              accountId: "work",
              channel: "slack",
              peer: { id: "U123", kind: "direct" },
            },
          },
        ],
      },
    });
    expect(
      ctx.resolveSlackSystemEventSessionKey({
        channelId: "D123",
        channelType: "im",
        senderId: "U123",
      }),
    ).toBe("agent:ops-dm:main");
  });
});

describe("isChannelAllowed with groupPolicy and channelsConfig", () => {
  it("allows unlisted channels when groupPolicy is open even with channelsConfig entries", () => {
    // Bug fix: when groupPolicy="open" and channels has some entries,
    // Unlisted channels should still be allowed (not blocked)
    const ctx = createListedChannelsContext("open");
    // Listed channel should be allowed
    expect(ctx.isChannelAllowed({ channelId: "C_LISTED", channelType: "channel" })).toBe(true);
    // Unlisted channel should ALSO be allowed when policy is "open"
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(true);
  });

  it("blocks unlisted channels when groupPolicy is allowlist", () => {
    const ctx = createListedChannelsContext("allowlist");
    // Listed channel should be allowed
    expect(ctx.isChannelAllowed({ channelId: "C_LISTED", channelType: "channel" })).toBe(true);
    // Unlisted channel should be blocked when policy is "allowlist"
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(false);
  });

  it("blocks explicitly denied channels even when groupPolicy is open", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      channelsConfig: {
        C_ALLOWED: { enabled: true },
        C_DENIED: { enabled: false },
      },
      groupPolicy: "open",
    });
    // Explicitly allowed channel
    expect(ctx.isChannelAllowed({ channelId: "C_ALLOWED", channelType: "channel" })).toBe(true);
    // Explicitly denied channel should be blocked even with open policy
    expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
    // Unlisted channel should be allowed with open policy
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(true);
  });

  it("allows all channels when groupPolicy is open and channelsConfig is empty", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      channelsConfig: undefined,
      groupPolicy: "open",
    });
    expect(ctx.isChannelAllowed({ channelId: "C_ANY", channelType: "channel" })).toBe(true);
  });
});
