import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordActionConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPresences, setPresence } from "../monitor/presence-cache.js";
import { discordGuildActionRuntime, handleDiscordGuildAction } from "./runtime.guild.js";
import { handleDiscordAction } from "./runtime.js";
import {
  discordMessagingActionRuntime,
  handleDiscordMessagingAction,
} from "./runtime.messaging.js";
import {
  discordModerationActionRuntime,
  handleDiscordModerationAction,
} from "./runtime.moderation.js";

const originalDiscordMessagingActionRuntime = { ...discordMessagingActionRuntime };
const originalDiscordGuildActionRuntime = { ...discordGuildActionRuntime };
const originalDiscordModerationActionRuntime = { ...discordModerationActionRuntime };

const discordSendMocks = {
  banMemberDiscord: vi.fn(async () => ({})),
  createChannelDiscord: vi.fn(async () => ({
    id: "new-channel",
    name: "test",
    type: 0,
  })),
  createThreadDiscord: vi.fn(async () => ({})),
  deleteChannelDiscord: vi.fn(async () => ({ channelId: "C1", ok: true })),
  deleteMessageDiscord: vi.fn(async () => ({})),
  editChannelDiscord: vi.fn(async () => ({
    id: "C1",
    name: "edited",
  })),
  editMessageDiscord: vi.fn(async () => ({})),
  fetchChannelPermissionsDiscord: vi.fn(async () => ({})),
  fetchMessageDiscord: vi.fn(async () => ({})),
  fetchReactionsDiscord: vi.fn(async () => ({})),
  kickMemberDiscord: vi.fn(async () => ({})),
  listGuildChannelsDiscord: vi.fn(async () => []),
  listPinsDiscord: vi.fn(async () => ({})),
  listThreadsDiscord: vi.fn(async () => ({})),
  moveChannelDiscord: vi.fn(async () => ({ ok: true })),
  pinMessageDiscord: vi.fn(async () => ({})),
  reactMessageDiscord: vi.fn(async () => ({})),
  readMessagesDiscord: vi.fn(async () => []),
  removeChannelPermissionDiscord: vi.fn(async () => ({ ok: true })),
  removeOwnReactionsDiscord: vi.fn(async () => ({ removed: ["👍"] })),
  removeReactionDiscord: vi.fn(async () => ({})),
  searchMessagesDiscord: vi.fn(async () => ({})),
  sendDiscordComponentMessage: vi.fn(async () => ({})),
  sendMessageDiscord: vi.fn(async () => ({})),
  sendPollDiscord: vi.fn(async () => ({})),
  sendStickerDiscord: vi.fn(async () => ({})),
  sendVoiceMessageDiscord: vi.fn(async () => ({})),
  setChannelPermissionDiscord: vi.fn(async () => ({ ok: true })),
  timeoutMemberDiscord: vi.fn(async () => ({})),
  unpinMessageDiscord: vi.fn(async () => ({})),
};

const {
  createChannelDiscord,
  createThreadDiscord,
  deleteChannelDiscord,
  editChannelDiscord,
  fetchMessageDiscord,
  kickMemberDiscord,
  listGuildChannelsDiscord,
  listPinsDiscord,
  moveChannelDiscord,
  reactMessageDiscord,
  readMessagesDiscord,
  removeChannelPermissionDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
  searchMessagesDiscord,
  sendDiscordComponentMessage,
  sendMessageDiscord,
  sendPollDiscord,
  sendVoiceMessageDiscord,
  setChannelPermissionDiscord,
  timeoutMemberDiscord,
} = discordSendMocks;

const enableAllActions = () => true;

const disabledActions = (key: keyof DiscordActionConfig) => key !== "reactions";
const channelInfoEnabled = (key: keyof DiscordActionConfig) => key === "channelInfo";
const moderationEnabled = (key: keyof DiscordActionConfig) => key === "moderation";

beforeEach(() => {
  vi.clearAllMocks();
  clearPresences();
  Object.assign(
    discordMessagingActionRuntime,
    originalDiscordMessagingActionRuntime,
    discordSendMocks,
  );
  Object.assign(discordGuildActionRuntime, originalDiscordGuildActionRuntime, discordSendMocks);
  Object.assign(
    discordModerationActionRuntime,
    originalDiscordModerationActionRuntime,
    discordSendMocks,
  );
});

describe("handleDiscordMessagingAction", () => {
  it.each([
    {
      expectedOptions: undefined,
      name: "without account",
      params: {
        channelId: "C1",
        emoji: "✅",
        messageId: "M1",
      },
    },
    {
      expectedOptions: { accountId: "ops" },
      name: "with accountId",
      params: {
        accountId: "ops",
        channelId: "C1",
        emoji: "✅",
        messageId: "M1",
      },
    },
  ])("adds reactions $name", async ({ params, expectedOptions }) => {
    await handleDiscordMessagingAction("react", params, enableAllActions);
    if (expectedOptions) {
      expect(reactMessageDiscord).toHaveBeenCalledWith("C1", "M1", "✅", expectedOptions);
      return;
    }
    expect(reactMessageDiscord).toHaveBeenCalledWith("C1", "M1", "✅", {});
  });

  it("uses configured defaultAccount when cfg is provided and accountId is omitted", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        emoji: "✅",
        messageId: "M1",
      },
      enableAllActions,
      undefined,
      {
        channels: {
          discord: {
            accounts: {
              work: { token: "token-work" },
            },
            defaultAccount: "work",
          },
        },
      } as OpenClawConfig,
    );

    expect(reactMessageDiscord).toHaveBeenCalledWith(
      "C1",
      "M1",
      "✅",
      expect.objectContaining({ accountId: "work" }),
    );
  });

  it("removes reactions on empty emoji", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        emoji: "",
        messageId: "M1",
      },
      enableAllActions,
    );
    expect(removeOwnReactionsDiscord).toHaveBeenCalledWith("C1", "M1", {});
  });

  it("removes reactions when remove flag set", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        emoji: "✅",
        messageId: "M1",
        remove: true,
      },
      enableAllActions,
    );
    expect(removeReactionDiscord).toHaveBeenCalledWith("C1", "M1", "✅", {});
  });

  it("rejects removes without emoji", async () => {
    await expect(
      handleDiscordMessagingAction(
        "react",
        {
          channelId: "C1",
          emoji: "",
          messageId: "M1",
          remove: true,
        },
        enableAllActions,
      ),
    ).rejects.toThrow(/Emoji is required/);
  });

  it("respects reaction gating", async () => {
    await expect(
      handleDiscordMessagingAction(
        "react",
        {
          channelId: "C1",
          emoji: "✅",
          messageId: "M1",
        },
        disabledActions,
      ),
    ).rejects.toThrow(/Discord reactions are disabled/);
  });

  it("parses string booleans for poll options", async () => {
    await handleDiscordMessagingAction(
      "poll",
      {
        allowMultiselect: "true",
        answers: ["Pizza", "Sushi"],
        durationHours: "24",
        question: "Lunch?",
        to: "channel:123",
      },
      enableAllActions,
    );

    expect(sendPollDiscord).toHaveBeenCalledWith(
      "channel:123",
      {
        durationHours: 24,
        maxSelections: 2,
        options: ["Pizza", "Sushi"],
        question: "Lunch?",
      },
      expect.any(Object),
    );
  });

  it("adds normalized timestamps to readMessages payloads", async () => {
    readMessagesDiscord.mockResolvedValueOnce([
      { id: "1", timestamp: "2026-01-15T10:00:00.000Z" },
    ] as never);

    const result = await handleDiscordMessagingAction(
      "readMessages",
      { channelId: "C1" },
      enableAllActions,
    );
    const payload = result.details as {
      messages: { timestampMs?: number; timestampUtc?: string }[];
    };

    const expectedMs = Date.parse("2026-01-15T10:00:00.000Z");
    expect(payload.messages[0].timestampMs).toBe(expectedMs);
    expect(payload.messages[0].timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("threads provided cfg into readMessages calls", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
        },
      },
    } as OpenClawConfig;
    await handleDiscordMessagingAction(
      "readMessages",
      { channelId: "C1" },
      enableAllActions,
      {},
      cfg,
    );
    expect(readMessagesDiscord).toHaveBeenCalledWith("C1", expect.any(Object), { cfg });
  });

  it("adds normalized timestamps to fetchMessage payloads", async () => {
    fetchMessageDiscord.mockResolvedValueOnce({
      id: "1",
      timestamp: "2026-01-15T11:00:00.000Z",
    });

    const result = await handleDiscordMessagingAction(
      "fetchMessage",
      { channelId: "C1", guildId: "G1", messageId: "M1" },
      enableAllActions,
    );
    const payload = result.details as { message?: { timestampMs?: number; timestampUtc?: string } };

    const expectedMs = Date.parse("2026-01-15T11:00:00.000Z");
    expect(payload.message?.timestampMs).toBe(expectedMs);
    expect(payload.message?.timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("threads provided cfg into fetchMessage calls", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
        },
      },
    } as OpenClawConfig;
    await handleDiscordMessagingAction(
      "fetchMessage",
      { channelId: "C1", guildId: "G1", messageId: "M1" },
      enableAllActions,
      {},
      cfg,
    );
    expect(fetchMessageDiscord).toHaveBeenCalledWith("C1", "M1", { cfg });
  });

  it("adds normalized timestamps to listPins payloads", async () => {
    listPinsDiscord.mockResolvedValueOnce([{ id: "1", timestamp: "2026-01-15T12:00:00.000Z" }]);

    const result = await handleDiscordMessagingAction(
      "listPins",
      { channelId: "C1" },
      enableAllActions,
    );
    const payload = result.details as {
      pins: { timestampMs?: number; timestampUtc?: string }[];
    };

    const expectedMs = Date.parse("2026-01-15T12:00:00.000Z");
    expect(payload.pins[0].timestampMs).toBe(expectedMs);
    expect(payload.pins[0].timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("adds normalized timestamps to searchMessages payloads", async () => {
    searchMessagesDiscord.mockResolvedValueOnce({
      messages: [[{ id: "1", timestamp: "2026-01-15T13:00:00.000Z" }]],
      total_results: 1,
    });

    const result = await handleDiscordMessagingAction(
      "searchMessages",
      { content: "hi", guildId: "G1" },
      enableAllActions,
    );
    const payload = result.details as {
      results?: { messages?: { timestampMs?: number; timestampUtc?: string }[][] };
    };

    const expectedMs = Date.parse("2026-01-15T13:00:00.000Z");
    expect(payload.results?.messages?.[0]?.[0]?.timestampMs).toBe(expectedMs);
    expect(payload.results?.messages?.[0]?.[0]?.timestampUtc).toBe(
      new Date(expectedMs).toISOString(),
    );
  });

  it("sends voice messages from a local file path", async () => {
    sendVoiceMessageDiscord.mockClear();
    sendMessageDiscord.mockClear();

    await handleDiscordMessagingAction(
      "sendMessage",
      {
        asVoice: true,
        path: "/tmp/voice.mp3",
        silent: true,
        to: "channel:123",
      },
      enableAllActions,
    );

    expect(sendVoiceMessageDiscord).toHaveBeenCalledWith("channel:123", "/tmp/voice.mp3", {
      replyTo: undefined,
      silent: true,
    });
    expect(sendMessageDiscord).not.toHaveBeenCalled();
  });

  it("forwards trusted mediaLocalRoots into sendMessageDiscord", async () => {
    sendMessageDiscord.mockClear();
    await handleDiscordMessagingAction(
      "sendMessage",
      {
        content: "hello",
        mediaUrl: "/tmp/image.png",
        to: "channel:123",
      },
      enableAllActions,
      { mediaLocalRoots: ["/tmp/agent-root"] },
    );
    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hello",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/agent-root"],
        mediaUrl: "/tmp/image.png",
      }),
    );
  });

  it("ignores empty components objects for regular media sends", async () => {
    sendMessageDiscord.mockClear();
    sendDiscordComponentMessage.mockClear();

    await handleDiscordMessagingAction(
      "sendMessage",
      {
        components: {},
        content: "hello",
        mediaUrl: "/tmp/image.png",
        to: "channel:123",
      },
      enableAllActions,
      { mediaLocalRoots: ["/tmp/agent-root"] },
    );

    expect(sendDiscordComponentMessage).not.toHaveBeenCalled();
    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hello",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/agent-root"],
        mediaUrl: "/tmp/image.png",
      }),
    );
  });

  it("forwards the optional filename into sendMessageDiscord", async () => {
    sendMessageDiscord.mockClear();
    await handleDiscordMessagingAction(
      "sendMessage",
      {
        content: "hello",
        filename: "image.png",
        mediaUrl: "/tmp/generated-image",
        to: "channel:123",
      },
      enableAllActions,
    );
    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hello",
      expect.objectContaining({
        filename: "image.png",
        mediaUrl: "/tmp/generated-image",
      }),
    );
  });

  it("rejects voice messages that include content", async () => {
    await expect(
      handleDiscordMessagingAction(
        "sendMessage",
        {
          asVoice: true,
          content: "hello",
          mediaUrl: "/tmp/voice.mp3",
          to: "channel:123",
        },
        enableAllActions,
      ),
    ).rejects.toThrow(/Voice messages cannot include text content/);
  });

  it("forwards optional thread content", async () => {
    createThreadDiscord.mockClear();
    await handleDiscordMessagingAction(
      "threadCreate",
      {
        channelId: "C1",
        content: "Initial forum post body",
        name: "Forum thread",
      },
      enableAllActions,
    );
    expect(createThreadDiscord).toHaveBeenCalledWith(
      "C1",
      {
        appliedTags: undefined,
        autoArchiveMinutes: undefined,
        content: "Initial forum post body",
        messageId: undefined,
        name: "Forum thread",
      },
      {},
    );
  });
});

describe("handleDiscordGuildAction", () => {
  it("uses configured defaultAccount for omitted memberInfo presence lookup", async () => {
    setPresence("work", "U1", {
      activities: [],
      client_status: {},
      guild_id: "G1",
      status: "online",
      user: { id: "U1" },
    } as never);

    discordGuildActionRuntime.fetchMemberInfoDiscord = vi.fn(async () => ({
      user: { id: "U1" },
    })) as never;

    const result = await handleDiscordGuildAction(
      "memberInfo",
      {
        guildId: "G1",
        userId: "U1",
      },
      enableAllActions,
      {
        channels: {
          discord: {
            accounts: {
              work: { token: "token-work" },
            },
            defaultAccount: "work",
          },
        },
      } as OpenClawConfig,
    );

    expect(discordGuildActionRuntime.fetchMemberInfoDiscord).toHaveBeenCalledWith("G1", "U1", {
      accountId: "work",
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        activities: [],
        ok: true,
        status: "online",
      }),
    );
  });
});

const channelsEnabled = (key: keyof DiscordActionConfig) => key === "channels";
const channelsDisabled = () => false;

describe("handleDiscordGuildAction - channel management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a channel", async () => {
    const result = await handleDiscordGuildAction(
      "channelCreate",
      {
        guildId: "G1",
        name: "test-channel",
        topic: "Test topic",
        type: 0,
      },
      channelsEnabled,
    );
    expect(createChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      name: "test-channel",
      nsfw: undefined,
      parentId: undefined,
      position: undefined,
      topic: "Test topic",
      type: 0,
    });
    expect(result.details).toMatchObject({ ok: true });
  });

  it("respects channel gating for channelCreate", async () => {
    await expect(
      handleDiscordGuildAction("channelCreate", { guildId: "G1", name: "test" }, channelsDisabled),
    ).rejects.toThrow(/Discord channel management is disabled/);
  });

  it("forwards accountId for channelList", async () => {
    await handleDiscordGuildAction(
      "channelList",
      { accountId: "ops", guildId: "G1" },
      channelInfoEnabled,
    );
    expect(listGuildChannelsDiscord).toHaveBeenCalledWith("G1", { accountId: "ops" });
  });

  it("edits a channel", async () => {
    await handleDiscordGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        name: "new-name",
        topic: "new topic",
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      archived: undefined,
      autoArchiveDuration: undefined,
      channelId: "C1",
      locked: undefined,
      name: "new-name",
      nsfw: undefined,
      parentId: undefined,
      position: undefined,
      rateLimitPerUser: undefined,
      topic: "new topic",
    });
  });

  it("forwards thread edit fields", async () => {
    await handleDiscordGuildAction(
      "channelEdit",
      {
        archived: true,
        autoArchiveDuration: 1440,
        channelId: "C1",
        locked: false,
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      archived: true,
      autoArchiveDuration: 1440,
      channelId: "C1",
      locked: false,
      name: undefined,
      nsfw: undefined,
      parentId: undefined,
      position: undefined,
      rateLimitPerUser: undefined,
      topic: undefined,
    });
  });

  it.each([
    ["parentId is null", { parentId: null }],
    ["clearParent is true", { clearParent: true }],
  ])("clears the channel parent when %s", async (_label, payload) => {
    await handleDiscordGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        ...payload,
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      archived: undefined,
      autoArchiveDuration: undefined,
      channelId: "C1",
      locked: undefined,
      name: undefined,
      nsfw: undefined,
      parentId: null,
      position: undefined,
      rateLimitPerUser: undefined,
      topic: undefined,
    });
  });

  it("deletes a channel", async () => {
    await handleDiscordGuildAction("channelDelete", { channelId: "C1" }, channelsEnabled);
    expect(deleteChannelDiscord).toHaveBeenCalledWith("C1");
  });

  it("moves a channel", async () => {
    await handleDiscordGuildAction(
      "channelMove",
      {
        channelId: "C1",
        guildId: "G1",
        parentId: "P1",
        position: 5,
      },
      channelsEnabled,
    );
    expect(moveChannelDiscord).toHaveBeenCalledWith({
      channelId: "C1",
      guildId: "G1",
      parentId: "P1",
      position: 5,
    });
  });

  it.each([
    ["parentId is null", { parentId: null }],
    ["clearParent is true", { clearParent: true }],
  ])("clears the channel parent on move when %s", async (_label, payload) => {
    await handleDiscordGuildAction(
      "channelMove",
      {
        channelId: "C1",
        guildId: "G1",
        ...payload,
      },
      channelsEnabled,
    );
    expect(moveChannelDiscord).toHaveBeenCalledWith({
      channelId: "C1",
      guildId: "G1",
      parentId: null,
      position: undefined,
    });
  });

  it("creates a category with type=4", async () => {
    await handleDiscordGuildAction(
      "categoryCreate",
      { guildId: "G1", name: "My Category" },
      channelsEnabled,
    );
    expect(createChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      name: "My Category",
      position: undefined,
      type: 4,
    });
  });

  it("edits a category", async () => {
    await handleDiscordGuildAction(
      "categoryEdit",
      { categoryId: "CAT1", name: "Renamed Category" },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      channelId: "CAT1",
      name: "Renamed Category",
      position: undefined,
    });
  });

  it("deletes a category", async () => {
    await handleDiscordGuildAction("categoryDelete", { categoryId: "CAT1" }, channelsEnabled);
    expect(deleteChannelDiscord).toHaveBeenCalledWith("CAT1");
  });

  it.each([
    {
      expected: {
        allow: "1024",
        channelId: "C1",
        deny: "2048",
        targetId: "R1",
        targetType: 0,
      },
      name: "role",
      params: {
        allow: "1024",
        channelId: "C1",
        deny: "2048",
        targetId: "R1",
        targetType: "role" as const,
      },
    },
    {
      expected: {
        allow: "1024",
        channelId: "C1",
        deny: undefined,
        targetId: "U1",
        targetType: 1,
      },
      name: "member",
      params: {
        allow: "1024",
        channelId: "C1",
        targetId: "U1",
        targetType: "member" as const,
      },
    },
  ])("sets channel permissions for $name", async ({ params, expected }) => {
    await handleDiscordGuildAction("channelPermissionSet", params, channelsEnabled);
    expect(setChannelPermissionDiscord).toHaveBeenCalledWith(expected);
  });

  it("removes channel permissions", async () => {
    await handleDiscordGuildAction(
      "channelPermissionRemove",
      { channelId: "C1", targetId: "R1" },
      channelsEnabled,
    );
    expect(removeChannelPermissionDiscord).toHaveBeenCalledWith("C1", "R1");
  });
});

describe("handleDiscordModerationAction", () => {
  it("forwards accountId for timeout", async () => {
    await handleDiscordModerationAction(
      "timeout",
      {
        accountId: "ops",
        durationMinutes: 5,
        guildId: "G1",
        userId: "U1",
      },
      moderationEnabled,
    );
    expect(timeoutMemberDiscord).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMinutes: 5,
        guildId: "G1",
        userId: "U1",
      }),
      { accountId: "ops" },
    );
  });
});

describe("handleDiscordAction per-account gating", () => {
  it("allows moderation when account config enables it", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: { actions: { moderation: true }, token: "tok-ops" },
          },
        },
      },
    } as OpenClawConfig;

    await handleDiscordAction(
      { accountId: "ops", action: "timeout", durationMinutes: 5, guildId: "G1", userId: "U1" },
      cfg,
    );
    expect(timeoutMemberDiscord).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "G1", userId: "U1" }),
      { accountId: "ops" },
    );
  });

  it("blocks moderation when account omits it", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            chat: { token: "tok-chat" },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleDiscordAction(
        { accountId: "chat", action: "timeout", durationMinutes: 5, guildId: "G1", userId: "U1" },
        cfg,
      ),
    ).rejects.toThrow(/Discord moderation is disabled/);
  });

  it("uses account-merged config, not top-level config", async () => {
    // Top-level has no moderation, but the account does
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: { actions: { moderation: true }, token: "tok-ops" },
          },
          token: "tok-base",
        },
      },
    } as OpenClawConfig;

    await handleDiscordAction(
      { accountId: "ops", action: "kick", guildId: "G1", userId: "U1" },
      cfg,
    );
    expect(kickMemberDiscord).toHaveBeenCalled();
  });

  it("inherits top-level channel gate when account overrides moderation only", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: { actions: { moderation: true }, token: "tok-ops" },
          },
          actions: { channels: false },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleDiscordAction(
        { accountId: "ops", action: "channelCreate", guildId: "G1", name: "alerts" },
        cfg,
      ),
    ).rejects.toThrow(/channel management is disabled/i);
  });

  it("allows account to explicitly re-enable top-level disabled channel gate", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: {
              actions: { channels: true, moderation: true },
              token: "tok-ops",
            },
          },
          actions: { channels: false },
        },
      },
    } as OpenClawConfig;

    await handleDiscordAction(
      { accountId: "ops", action: "channelCreate", guildId: "G1", name: "alerts" },
      cfg,
    );

    expect(createChannelDiscord).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "G1", name: "alerts" }),
      { accountId: "ops" },
    );
  });
});
