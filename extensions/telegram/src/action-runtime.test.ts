import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { captureEnv } from "openclaw/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleTelegramAction,
  readTelegramButtons,
  telegramActionRuntime,
} from "./action-runtime.js";

const originalTelegramActionRuntime = { ...telegramActionRuntime };
const reactMessageTelegram = vi.fn(async () => ({ ok: true }));
const sendMessageTelegram = vi.fn(async () => ({
  chatId: "123",
  messageId: "789",
}));
const sendPollTelegram = vi.fn(async () => ({
  chatId: "123",
  messageId: "790",
  pollId: "poll-1",
}));
const sendStickerTelegram = vi.fn(async () => ({
  chatId: "123",
  messageId: "456",
}));
const deleteMessageTelegram = vi.fn(async () => ({ ok: true }));
const editMessageTelegram = vi.fn(async () => ({
  chatId: "123",
  messageId: "456",
  ok: true,
}));
const editForumTopicTelegram = vi.fn(async () => ({
  chatId: "123",
  messageThreadId: 42,
  name: "Renamed",
  ok: true,
}));
const createForumTopicTelegram = vi.fn(async () => ({
  chatId: "123",
  name: "Topic",
  topicId: 99,
}));
let envSnapshot: ReturnType<typeof captureEnv>;

describe("handleTelegramAction", () => {
  const defaultReactionAction = {
    action: "react",
    chatId: "123",
    emoji: "✅",
    messageId: "456",
  } as const;

  function reactionConfig(reactionLevel: "minimal" | "extensive" | "off" | "ack"): OpenClawConfig {
    return {
      channels: { telegram: { botToken: "tok", reactionLevel } },
    } as OpenClawConfig;
  }

  function telegramConfig(overrides?: Record<string, unknown>): OpenClawConfig {
    return {
      channels: {
        telegram: {
          botToken: "tok",
          ...overrides,
        },
      },
    } as OpenClawConfig;
  }

  async function sendInlineButtonsMessage(params: {
    to: string;
    buttons: { text: string; callback_data: string; style?: string }[][];
    inlineButtons: "dm" | "group" | "all";
  }) {
    await handleTelegramAction(
      {
        action: "sendMessage",
        buttons: params.buttons,
        content: "Choose",
        to: params.to,
      },
      telegramConfig({ capabilities: { inlineButtons: params.inlineButtons } }),
    );
  }

  async function expectReactionAdded(reactionLevel: "minimal" | "extensive") {
    await handleTelegramAction(defaultReactionAction, reactionConfig(reactionLevel));
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "✅",
      expect.objectContaining({ remove: false, token: "tok" }),
    );
  }

  beforeEach(() => {
    envSnapshot = captureEnv(["TELEGRAM_BOT_TOKEN"]);
    Object.assign(telegramActionRuntime, originalTelegramActionRuntime, {
      createForumTopicTelegram,
      deleteMessageTelegram,
      editForumTopicTelegram,
      editMessageTelegram,
      reactMessageTelegram,
      sendMessageTelegram,
      sendPollTelegram,
      sendStickerTelegram,
    });
    reactMessageTelegram.mockClear();
    sendMessageTelegram.mockClear();
    sendPollTelegram.mockClear();
    sendStickerTelegram.mockClear();
    deleteMessageTelegram.mockClear();
    editMessageTelegram.mockClear();
    editForumTopicTelegram.mockClear();
    createForumTopicTelegram.mockClear();
    process.env.TELEGRAM_BOT_TOKEN = "tok";
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("adds reactions when reactionLevel is minimal", async () => {
    await expectReactionAdded("minimal");
  });

  it("surfaces non-fatal reaction warnings", async () => {
    reactMessageTelegram.mockResolvedValueOnce({
      ok: false,
      warning: "Reaction unavailable: ✅",
    } as unknown as Awaited<ReturnType<typeof reactMessageTelegram>>);
    const result = await handleTelegramAction(defaultReactionAction, reactionConfig("minimal"));
    const textPayload = result.content.find((item) => item.type === "text");
    expect(textPayload?.type).toBe("text");
    const parsed = JSON.parse((textPayload as { type: "text"; text: string }).text) as {
      ok: boolean;
      warning?: string;
      added?: string;
    };
    expect(parsed).toMatchObject({
      added: "✅",
      ok: false,
      warning: "Reaction unavailable: ✅",
    });
  });

  it("adds reactions when reactionLevel is extensive", async () => {
    await expectReactionAdded("extensive");
  });

  it("accepts snake_case message_id for reactions", async () => {
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        emoji: "✅",
        message_id: "456",
      },
      reactionConfig("minimal"),
    );
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "✅",
      expect.objectContaining({ remove: false, token: "tok" }),
    );
  });

  it("soft-fails when messageId is missing", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", reactionLevel: "minimal" } },
    } as OpenClawConfig;
    const result = await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        emoji: "✅",
      },
      cfg,
    );
    expect(result.details).toMatchObject({
      ok: false,
      reason: "missing_message_id",
    });
    expect(reactMessageTelegram).not.toHaveBeenCalled();
  });

  it("removes reactions on empty emoji", async () => {
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        emoji: "",
        messageId: "456",
      },
      reactionConfig("minimal"),
    );
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "",
      expect.objectContaining({ remove: false, token: "tok" }),
    );
  });

  it("rejects sticker actions when disabled by default", async () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
    await expect(
      handleTelegramAction(
        {
          action: "sendSticker",
          fileId: "sticker",
          to: "123",
        },
        cfg,
      ),
    ).rejects.toThrow(/sticker actions are disabled/i);
    expect(sendStickerTelegram).not.toHaveBeenCalled();
  });

  it("sends stickers when enabled", async () => {
    const cfg = {
      channels: { telegram: { actions: { sticker: true }, botToken: "tok" } },
    } as OpenClawConfig;
    await handleTelegramAction(
      {
        action: "sendSticker",
        fileId: "sticker",
        to: "123",
      },
      cfg,
    );
    expect(sendStickerTelegram).toHaveBeenCalledWith(
      "123",
      "sticker",
      expect.objectContaining({ token: "tok" }),
    );
  });

  it("accepts shared sticker action aliases", async () => {
    const cfg = {
      channels: { telegram: { actions: { sticker: true }, botToken: "tok" } },
    } as OpenClawConfig;
    await handleTelegramAction(
      {
        action: "sticker",
        replyTo: 9,
        stickerId: ["sticker"],
        target: "123",
        threadId: 11,
      },
      cfg,
    );
    expect(sendStickerTelegram).toHaveBeenCalledWith(
      "123",
      "sticker",
      expect.objectContaining({
        messageThreadId: 11,
        replyToMessageId: 9,
        token: "tok",
      }),
    );
  });

  it("removes reactions when remove flag set", async () => {
    const cfg = reactionConfig("extensive");
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        emoji: "✅",
        messageId: "456",
        remove: true,
      },
      cfg,
    );
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "✅",
      expect.objectContaining({ remove: true, token: "tok" }),
    );
  });

  it.each(["off", "ack"] as const)(
    "soft-fails reactions when reactionLevel is %s",
    async (level) => {
      const result = await handleTelegramAction(
        {
          action: "react",
          chatId: "123",
          emoji: "✅",
          messageId: "456",
        },
        reactionConfig(level),
      );
      expect(result.details).toMatchObject({
        ok: false,
        reason: "disabled",
      });
    },
  );

  it("soft-fails when reactions are disabled via actions.reactions", async () => {
    const cfg = {
      channels: {
        telegram: {
          actions: { reactions: false },
          botToken: "tok",
          reactionLevel: "minimal",
        },
      },
    } as OpenClawConfig;
    const result = await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        emoji: "✅",
        messageId: "456",
      },
      cfg,
    );
    expect(result.details).toMatchObject({
      ok: false,
      reason: "disabled",
    });
  });

  it("sends a text message", async () => {
    const result = await handleTelegramAction(
      {
        action: "sendMessage",
        content: "Hello, Telegram!",
        to: "@testchannel",
      },
      telegramConfig(),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Hello, Telegram!",
      expect.objectContaining({ mediaUrl: undefined, token: "tok" }),
    );
    expect(result.content).toContainEqual({
      text: expect.stringContaining('"ok": true'),
      type: "text",
    });
  });

  it("accepts shared send action aliases", async () => {
    await handleTelegramAction(
      {
        action: "send",
        media: "https://example.com/image.jpg",
        message: "Hello from alias",
        to: "@testchannel",
      },
      telegramConfig(),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Hello from alias",
      expect.objectContaining({
        mediaUrl: "https://example.com/image.jpg",
        token: "tok",
      }),
    );
  });

  it("sends a poll", async () => {
    const result = await handleTelegramAction(
      {
        action: "poll",
        allowMultiselect: true,
        answers: ["Yes", "No"],
        durationSeconds: 60,
        isAnonymous: false,
        question: "Ready?",
        silent: true,
        to: "@testchannel",
      },
      telegramConfig(),
    );
    expect(sendPollTelegram).toHaveBeenCalledWith(
      "@testchannel",
      {
        durationHours: undefined,
        durationSeconds: 60,
        maxSelections: 2,
        options: ["Yes", "No"],
        question: "Ready?",
      },
      expect.objectContaining({
        isAnonymous: false,
        silent: true,
        token: "tok",
      }),
    );
    expect(result.details).toMatchObject({
      chatId: "123",
      messageId: "790",
      ok: true,
      pollId: "poll-1",
    });
  });

  it("accepts shared poll action aliases", async () => {
    await handleTelegramAction(
      {
        action: "poll",
        pollDurationSeconds: 60,
        pollMulti: "true",
        pollOption: ["Yes", "No"],
        pollPublic: "true",
        pollQuestion: "Ready?",
        replyTo: 55,
        silent: "true",
        threadId: 77,
        to: "@testchannel",
      },
      telegramConfig(),
    );
    expect(sendPollTelegram).toHaveBeenCalledWith(
      "@testchannel",
      {
        durationHours: undefined,
        durationSeconds: 60,
        maxSelections: 2,
        options: ["Yes", "No"],
        question: "Ready?",
      },
      expect.objectContaining({
        isAnonymous: false,
        messageThreadId: 77,
        replyToMessageId: 55,
        silent: true,
        token: "tok",
      }),
    );
  });

  it("parses string booleans for poll flags", async () => {
    await handleTelegramAction(
      {
        action: "poll",
        allowMultiselect: "true",
        answers: ["Yes", "No"],
        isAnonymous: "false",
        question: "Ready?",
        silent: "true",
        to: "@testchannel",
      },
      telegramConfig(),
    );
    expect(sendPollTelegram).toHaveBeenCalledWith(
      "@testchannel",
      expect.objectContaining({
        maxSelections: 2,
        options: ["Yes", "No"],
        question: "Ready?",
      }),
      expect.objectContaining({
        isAnonymous: false,
        silent: true,
      }),
    );
  });

  it("forwards trusted mediaLocalRoots into sendMessageTelegram", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        content: "Hello with local media",
        to: "@testchannel",
      },
      telegramConfig(),
      { mediaLocalRoots: ["/tmp/agent-root"] },
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Hello with local media",
      expect.objectContaining({ mediaLocalRoots: ["/tmp/agent-root"] }),
    );
  });

  it.each([
    {
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(reactMessageTelegram.mock.calls as unknown[][], 3),
      cfg: reactionConfig("minimal"),
      name: "react",
      params: { action: "react", chatId: "123", emoji: "✅", messageId: 456 },
    },
    {
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(sendMessageTelegram.mock.calls as unknown[][], 2),
      cfg: telegramConfig(),
      name: "sendMessage",
      params: { action: "sendMessage", content: "hello", to: "123" },
    },
    {
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(sendPollTelegram.mock.calls as unknown[][], 2),
      cfg: telegramConfig(),
      name: "poll",
      params: {
        action: "poll",
        answers: ["A", "B"],
        question: "Q?",
        to: "123",
      },
    },
    {
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(deleteMessageTelegram.mock.calls as unknown[][], 2),
      cfg: telegramConfig(),
      name: "deleteMessage",
      params: { action: "deleteMessage", chatId: "123", messageId: 1 },
    },
    {
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(editMessageTelegram.mock.calls as unknown[][], 3),
      cfg: telegramConfig(),
      name: "editMessage",
      params: { action: "editMessage", chatId: "123", content: "updated", messageId: 1 },
    },
    {
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(sendStickerTelegram.mock.calls as unknown[][], 2),
      cfg: telegramConfig({ actions: { sticker: true } }),
      name: "sendSticker",
      params: { action: "sendSticker", fileId: "sticker-1", to: "123" },
    },
    {
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(createForumTopicTelegram.mock.calls as unknown[][], 2),
      cfg: telegramConfig({ actions: { createForumTopic: true } }),
      name: "createForumTopic",
      params: { action: "createForumTopic", chatId: "123", name: "Topic" },
    },
    {
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(editForumTopicTelegram.mock.calls as unknown[][], 2),
      cfg: telegramConfig({ actions: { editForumTopic: true } }),
      name: "editForumTopic",
      params: { action: "editForumTopic", chatId: "123", messageThreadId: 42, name: "New" },
    },
  ])("forwards resolved cfg for $name action", async ({ params, cfg, assertCall }) => {
    const readCallOpts = (calls: unknown[][], argIndex: number): Record<string, unknown> => {
      const args = calls[0];
      if (!Array.isArray(args)) {
        throw new Error("Expected Telegram action call args");
      }
      const opts = args[argIndex];
      if (!opts || typeof opts !== "object") {
        throw new Error("Expected Telegram action options object");
      }
      return opts as Record<string, unknown>;
    };
    await handleTelegramAction(params as Record<string, unknown>, cfg);
    const opts = assertCall(readCallOpts);
    expect(opts.cfg).toBe(cfg);
  });

  it.each([
    {
      expectedContent: "Check this image!",
      expectedOptions: { mediaUrl: "https://example.com/image.jpg" },
      expectedTo: "123456",
      name: "media",
      params: {
        action: "sendMessage",
        content: "Check this image!",
        mediaUrl: "https://example.com/image.jpg",
        to: "123456",
      },
    },
    {
      expectedContent: "Replying now",
      expectedOptions: {
        quoteText: "The text you want to quote",
        replyToMessageId: 144,
      },
      expectedTo: "123456",
      name: "quoteText",
      params: {
        action: "sendMessage",
        content: "Replying now",
        quoteText: "The text you want to quote",
        replyToMessageId: 144,
        to: "123456",
      },
    },
    {
      expectedContent: "",
      expectedOptions: { mediaUrl: "https://example.com/note.ogg" },
      expectedTo: "123456",
      name: "media-only",
      params: {
        action: "sendMessage",
        mediaUrl: "https://example.com/note.ogg",
        to: "123456",
      },
    },
  ] as const)("maps sendMessage params for $name", async (testCase) => {
    await handleTelegramAction(testCase.params, telegramConfig());
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      testCase.expectedTo,
      testCase.expectedContent,
      expect.objectContaining({
        token: "tok",
        ...testCase.expectedOptions,
      }),
    );
  });

  it("requires content when no mediaUrl is provided", async () => {
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          to: "123456",
        },
        telegramConfig(),
      ),
    ).rejects.toThrow(/content required/i);
  });

  it("respects sendMessage gating", async () => {
    const cfg = {
      channels: {
        telegram: { actions: { sendMessage: false }, botToken: "tok" },
      },
    } as OpenClawConfig;
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          content: "Hello!",
          to: "@testchannel",
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram sendMessage is disabled/);
  });

  it("respects poll gating", async () => {
    const cfg = {
      channels: {
        telegram: { actions: { poll: false }, botToken: "tok" },
      },
    } as OpenClawConfig;
    await expect(
      handleTelegramAction(
        {
          action: "poll",
          answers: ["Pizza", "Sushi"],
          question: "Lunch?",
          to: "@testchannel",
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram polls are disabled/);
  });

  it("deletes a message", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as OpenClawConfig;
    await handleTelegramAction(
      {
        action: "deleteMessage",
        chatId: "123",
        messageId: 456,
      },
      cfg,
    );
    expect(deleteMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      expect.objectContaining({ token: "tok" }),
    );
  });

  it("respects deleteMessage gating", async () => {
    const cfg = {
      channels: {
        telegram: { actions: { deleteMessage: false }, botToken: "tok" },
      },
    } as OpenClawConfig;
    await expect(
      handleTelegramAction(
        {
          action: "deleteMessage",
          chatId: "123",
          messageId: 456,
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram deleteMessage is disabled/);
  });

  it("throws on missing bot token for sendMessage", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const cfg = {} as OpenClawConfig;
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          content: "Hello!",
          to: "@testchannel",
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram bot token missing/);
  });

  it("allows inline buttons by default (allowlist)", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as OpenClawConfig;
    await handleTelegramAction(
      {
        action: "sendMessage",
        buttons: [[{ callback_data: "cmd:ok", text: "Ok" }]],
        content: "Choose",
        to: "@testchannel",
      },
      cfg,
    );
    expect(sendMessageTelegram).toHaveBeenCalled();
  });

  it.each([
    {
      expectedMessage: /inline buttons are disabled/i,
      inlineButtons: "off" as const,
      name: "scope is off",
      to: "@testchannel",
    },
    {
      expectedMessage: /inline buttons are limited to DMs/i,
      inlineButtons: "dm" as const,
      name: "scope is dm and target is group",
      to: "-100123456",
    },
  ])("blocks inline buttons when $name", async ({ to, inlineButtons, expectedMessage }) => {
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          buttons: [[{ callback_data: "cmd:ok", text: "Ok" }]],
          content: "Choose",
          to,
        },
        telegramConfig({ capabilities: { inlineButtons } }),
      ),
    ).rejects.toThrow(expectedMessage);
  });

  it("allows inline buttons in DMs with tg: prefixed targets", async () => {
    await sendInlineButtonsMessage({
      buttons: [[{ callback_data: "cmd:ok", text: "Ok" }]],
      inlineButtons: "dm",
      to: "tg:5232990709",
    });
    expect(sendMessageTelegram).toHaveBeenCalled();
  });

  it("allows inline buttons in groups with topic targets", async () => {
    await sendInlineButtonsMessage({
      buttons: [[{ callback_data: "cmd:ok", text: "Ok" }]],
      inlineButtons: "group",
      to: "telegram:group:-1001234567890:topic:456",
    });
    expect(sendMessageTelegram).toHaveBeenCalled();
  });

  it("sends messages with inline keyboard buttons when enabled", async () => {
    await sendInlineButtonsMessage({
      buttons: [[{ callback_data: " cmd:a ", text: "  Option A " }]],
      inlineButtons: "all",
      to: "@testchannel",
    });
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Choose",
      expect.objectContaining({
        buttons: [[{ callback_data: "cmd:a", text: "Option A" }]],
      }),
    );
  });

  it("forwards optional button style", async () => {
    await sendInlineButtonsMessage({
      buttons: [
        [
          {
            callback_data: "cmd:a",
            style: "primary",
            text: "Option A",
          },
        ],
      ],
      inlineButtons: "all",
      to: "@testchannel",
    });
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Choose",
      expect.objectContaining({
        buttons: [
          [
            {
              callback_data: "cmd:a",
              style: "primary",
              text: "Option A",
            },
          ],
        ],
      }),
    );
  });
});

describe("readTelegramButtons", () => {
  it("returns trimmed button rows for valid input", () => {
    const result = readTelegramButtons({
      buttons: [[{ callback_data: " cmd:a ", text: "  Option A " }]],
    });
    expect(result).toEqual([[{ callback_data: "cmd:a", text: "Option A" }]]);
  });

  it("normalizes optional style", () => {
    const result = readTelegramButtons({
      buttons: [
        [
          {
            callback_data: "cmd:a",
            style: " PRIMARY ",
            text: "Option A",
          },
        ],
      ],
    });
    expect(result).toEqual([
      [
        {
          callback_data: "cmd:a",
          style: "primary",
          text: "Option A",
        },
      ],
    ]);
  });

  it("rejects unsupported button style", () => {
    expect(() =>
      readTelegramButtons({
        buttons: [[{ callback_data: "cmd:a", style: "secondary", text: "Option A" }]],
      }),
    ).toThrow(/style must be one of danger, success, primary/i);
  });

  it("rejects callback_data over Telegram's 64-byte limit", () => {
    expect(() =>
      readTelegramButtons({
        buttons: [[{ callback_data: "x".repeat(65), text: "Option A" }]],
      }),
    ).toThrow(/callback_data too long/i);
  });

  it("accepts multibyte callback_data at 64 bytes and rejects 68 bytes", () => {
    expect(
      readTelegramButtons({
        buttons: [[{ callback_data: "😀".repeat(16), text: "Option A" }]],
      }),
    ).toEqual([[{ callback_data: "😀".repeat(16), text: "Option A" }]]);

    expect(() =>
      readTelegramButtons({
        buttons: [[{ callback_data: "😀".repeat(17), text: "Option A" }]],
      }),
    ).toThrow(/callback_data too long/i);
  });
});

describe("handleTelegramAction per-account gating", () => {
  function accountTelegramConfig(params: {
    accounts: Record<
      string,
      { botToken: string; actions?: { sticker?: boolean; reactions?: boolean } }
    >;
    topLevelBotToken?: string;
    topLevelActions?: { reactions?: boolean };
  }): OpenClawConfig {
    return {
      channels: {
        telegram: {
          ...(params.topLevelBotToken ? { botToken: params.topLevelBotToken } : {}),
          ...(params.topLevelActions ? { actions: params.topLevelActions } : {}),
          accounts: params.accounts,
        },
      },
    } as OpenClawConfig;
  }

  async function expectAccountStickerSend(cfg: OpenClawConfig, accountId = "media") {
    await handleTelegramAction(
      { accountId, action: "sendSticker", fileId: "sticker-id", to: "123" },
      cfg,
    );
    expect(sendStickerTelegram).toHaveBeenCalledWith(
      "123",
      "sticker-id",
      expect.objectContaining({ token: "tok-media" }),
    );
  }

  it("allows sticker when account config enables it", async () => {
    const cfg = accountTelegramConfig({
      accounts: {
        media: { actions: { sticker: true }, botToken: "tok-media" },
      },
    });
    await expectAccountStickerSend(cfg);
  });

  it("blocks sticker when account omits it", async () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            chat: { botToken: "tok-chat" },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleTelegramAction(
        { accountId: "chat", action: "sendSticker", fileId: "sticker-id", to: "123" },
        cfg,
      ),
    ).rejects.toThrow(/sticker actions are disabled/i);
  });

  it("uses account-merged config, not top-level config", async () => {
    // Top-level has no sticker enabled, but the account does
    const cfg = accountTelegramConfig({
      accounts: {
        media: { actions: { sticker: true }, botToken: "tok-media" },
      },
      topLevelBotToken: "tok-base",
    });
    await expectAccountStickerSend(cfg);
  });

  it("inherits top-level reaction gate when account overrides sticker only", async () => {
    const cfg = accountTelegramConfig({
      accounts: {
        media: { actions: { sticker: true }, botToken: "tok-media" },
      },
      topLevelActions: { reactions: false },
    });

    const result = await handleTelegramAction(
      {
        accountId: "media",
        action: "react",
        chatId: "123",
        emoji: "👀",
        messageId: 1,
      },
      cfg,
    );
    expect(result.details).toMatchObject({
      ok: false,
      reason: "disabled",
    });
  });

  it("allows account to explicitly re-enable top-level disabled reaction gate", async () => {
    const cfg = accountTelegramConfig({
      accounts: {
        media: { actions: { reactions: true, sticker: true }, botToken: "tok-media" },
      },
      topLevelActions: { reactions: false },
    });

    await handleTelegramAction(
      {
        accountId: "media",
        action: "react",
        chatId: "123",
        emoji: "👀",
        messageId: 1,
      },
      cfg,
    );

    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      1,
      "👀",
      expect.objectContaining({ accountId: "media", token: "tok-media" }),
    );
  });
});
