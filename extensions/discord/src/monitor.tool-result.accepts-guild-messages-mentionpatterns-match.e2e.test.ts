import { ChannelType, MessageType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMock } from "./monitor.tool-result.test-harness.js";
import {
  type Config,
  captureNextDispatchCtx,
  createGuildHandler,
  createGuildMessageEvent,
  createGuildTextClient,
  createMentionRequiredGuildConfig,
  createThreadChannel,
  createThreadClient,
  createThreadEvent,
  resetDiscordToolResultHarness,
} from "./monitor.tool-result.test-helpers.js";

beforeEach(() => {
  resetDiscordToolResultHarness();
});

async function createHandler(cfg: Config) {
  return createGuildHandler({ cfg });
}

function createOpenGuildConfig(
  channels: Record<string, { allow: boolean; includeThreadStarter?: boolean }>,
  extra: Partial<Config> = {},
): Config {
  const cfg: Config = {
    ...createMentionRequiredGuildConfig(),
    ...extra,
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
        groupPolicy: "open",
        guilds: {
          "*": {
            channels,
            requireMention: false,
          },
        },
      },
    },
  };
  return cfg;
}

describe("discord tool result dispatch", () => {
  it("accepts guild messages when mentionPatterns match", async () => {
    const cfg = createMentionRequiredGuildConfig({
      messages: {
        groupChat: { mentionPatterns: [String.raw`\bopenclaw\b`] },
        inbound: { debounceMs: 0 },
      },
    } as Partial<Config>);

    const handler = await createHandler(cfg);
    const client = createGuildTextClient();

    await handler(createGuildMessageEvent({ content: "openclaw: hello", messageId: "m2" }), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
  });

  it("accepts guild reply-to-bot messages as implicit mentions", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{ WasMentioned?: boolean }>();
    const cfg = createMentionRequiredGuildConfig();
    const handler = await createHandler(cfg);
    const client = createGuildTextClient();

    await handler(
      createGuildMessageEvent({
        content: "following up",
        messageId: "m3",
        messagePatch: {
          referencedMessage: {
            attachments: [],
            author: { bot: true, id: "bot-id", username: "OpenClaw" },
            channelId: "c1",
            content: "bot reply",
            embeds: [],
            id: "m2",
            mentionedEveryone: false,
            mentionedRoles: [],
            mentionedUsers: [],
            timestamp: new Date().toISOString(),
            type: MessageType.Default,
          },
        },
      }),
      client,
    );

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });

  it("forks thread sessions and injects starter context", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    }>();
    const cfg = createOpenGuildConfig({ p1: { allow: true } });

    const handler = await createHandler(cfg);
    const client = createThreadClient({
      fetchChannel: vi
        .fn()
        .mockResolvedValueOnce(createThreadChannel({ includeStarter: true }))
        .mockResolvedValueOnce({ id: "p1", name: "general", type: ChannelType.GuildText }),
    });

    await handler(createThreadEvent("m4"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:main:discord:channel:p1");
    expect(capturedCtx?.ThreadStarterBody).toContain("starter message");
    expect(capturedCtx?.ThreadLabel).toContain("Discord thread #general");
  });

  it("skips thread starter context when disabled", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{ ThreadStarterBody?: string }>();
    const cfg = createOpenGuildConfig({
      p1: { allow: true, includeThreadStarter: false },
    });

    const handler = await createHandler(cfg);
    const client = createThreadClient();

    await handler(createThreadEvent("m7"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(getCapturedCtx()?.ThreadStarterBody).toBeUndefined();
  });

  it("treats forum threads as distinct sessions without channel payloads", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    }>();
    const cfg = createOpenGuildConfig({ "forum-1": { allow: true } });

    const fetchChannel = vi
      .fn()
      .mockResolvedValueOnce({
        id: "t1",
        name: "topic-1",
        parentId: "forum-1",
        type: ChannelType.PublicThread,
      })
      .mockResolvedValueOnce({
        id: "forum-1",
        name: "support",
        type: ChannelType.GuildForum,
      });
    const restGet = vi.fn().mockResolvedValue({
      author: { discriminator: "0001", id: "u1", username: "Alice" },
      content: "starter message",
      timestamp: new Date().toISOString(),
    });
    const handler = await createHandler(cfg);
    const client = createThreadClient({ fetchChannel, restGet });

    await handler(createThreadEvent("m6"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:main:discord:channel:forum-1");
    expect(capturedCtx?.ThreadStarterBody).toContain("starter message");
    expect(capturedCtx?.ThreadLabel).toContain("Discord thread #support");
  });

  it("scopes thread sessions to the routed agent", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
    }>();
    const cfg = createOpenGuildConfig(
      { p1: { allow: true } },
      { bindings: [{ agentId: "support", match: { channel: "discord", guildId: "g1" } }] },
    );

    const handler = await createHandler(cfg);
    const client = createThreadClient();

    await handler(createThreadEvent("m5"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:support:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:support:discord:channel:p1");
  });
});
