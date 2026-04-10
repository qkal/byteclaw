import { describe, expect, it } from "vitest";
import { buildDiscordNativeCommandContext } from "./native-command-context.js";

describe("buildDiscordNativeCommandContext", () => {
  it("builds direct-message slash command context", () => {
    const ctx = buildDiscordNativeCommandContext({
      accountId: "default",
      channelId: "dm-1",
      commandArgs: {},
      commandAuthorized: true,
      commandTargetSessionKey: "agent:codex:discord:direct:user-1",
      interactionId: "interaction-1",
      isDirectMessage: true,
      isGroupDm: false,
      isGuild: false,
      isThreadChannel: false,
      prompt: "/status",
      sender: {
        id: "user-1",
        tag: "tester#0001",
      },
      sessionKey: "agent:codex:discord:slash:user-1",
      timestampMs: 123,
      user: {
        globalName: "Tester",
        id: "user-1",
        username: "tester",
      },
    });

    expect(ctx.From).toBe("discord:user-1");
    expect(ctx.To).toBe("slash:user-1");
    expect(ctx.ChatType).toBe("direct");
    expect(ctx.ConversationLabel).toBe("Tester");
    expect(ctx.SessionKey).toBe("agent:codex:discord:slash:user-1");
    expect(ctx.CommandTargetSessionKey).toBe("agent:codex:discord:direct:user-1");
    expect(ctx.OriginatingTo).toBe("user:user-1");
    expect(ctx.UntrustedContext).toBeUndefined();
    expect(ctx.GroupSystemPrompt).toBeUndefined();
    expect(ctx.Timestamp).toBe(123);
  });

  it("builds guild slash command context with owner allowlist and channel metadata", () => {
    const ctx = buildDiscordNativeCommandContext({
      accountId: "default",
      allowNameMatching: false,
      channelConfig: {
        allowed: true,
        systemPrompt: "Use the runbook.",
        users: ["discord:user-1"],
      },
      channelId: "chan-1",
      channelTopic: "Production alerts only",
      commandArgs: { values: { model: "gpt-5.2" } },
      commandAuthorized: true,
      commandTargetSessionKey: "agent:codex:discord:channel:chan-1",
      guildInfo: {
        id: "guild-1",
      },
      guildName: "Ops",
      interactionId: "interaction-1",
      isDirectMessage: false,
      isGroupDm: false,
      isGuild: true,
      isThreadChannel: true,
      prompt: "/status",
      sender: {
        id: "user-1",
        name: "tester",
        tag: "tester#0001",
      },
      sessionKey: "agent:codex:discord:slash:user-1",
      threadParentId: "parent-1",
      timestampMs: 456,
      user: {
        id: "user-1",
        username: "tester",
      },
    });

    expect(ctx.From).toBe("discord:channel:chan-1");
    expect(ctx.ChatType).toBe("channel");
    expect(ctx.ConversationLabel).toBe("chan-1");
    expect(ctx.GroupSubject).toBe("Ops");
    expect(ctx.GroupSystemPrompt).toBe("Use the runbook.");
    expect(ctx.OwnerAllowFrom).toEqual(["user-1"]);
    expect(ctx.MessageThreadId).toBe("chan-1");
    expect(ctx.ThreadParentId).toBe("parent-1");
    expect(ctx.OriginatingTo).toBe("channel:chan-1");
    expect(ctx.UntrustedContext).toEqual([
      expect.stringContaining("Discord channel topic:\nProduction alerts only"),
    ]);
    expect(ctx.Timestamp).toBe(456);
  });
});
