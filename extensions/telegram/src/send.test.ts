import type { Bot } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";
import {
  clearSentMessageCache,
  recordSentMessage,
  resetSentMessageCacheForTest,
  wasSentByBot,
} from "./sent-message-cache.js";

installTelegramSendTestHooks();

const {
  botApi,
  botCtorSpy,
  imageMetadata,
  loadConfig,
  loadWebMedia,
  maybePersistResolvedTelegramTarget,
  resolveStorePath,
} = getTelegramSendTestMocks();
const {
  buildInlineKeyboard,
  createForumTopicTelegram,
  editForumTopicTelegram,
  editMessageTelegram,
  pinMessageTelegram,
  reactMessageTelegram,
  renameForumTopicTelegram,
  sendMessageTelegram,
  sendTypingTelegram,
  sendPollTelegram,
  sendStickerTelegram,
  unpinMessageTelegram,
} = await importTelegramSendModule();

async function expectChatNotFoundWithChatId(
  action: Promise<unknown>,
  expectedChatId: string,
): Promise<void> {
  try {
    await action;
    throw new Error("Expected action to reject with chat-not-found context");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Expected action to reject with chat-not-found context"
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/chat not found/i);
    expect(message).toMatch(new RegExp(`chat_id=${expectedChatId}`));
  }
}

async function expectTelegramMembershipErrorWithChatId(
  action: Promise<unknown>,
  expectedChatId: string,
  expectedDetail: RegExp,
): Promise<void> {
  try {
    await action;
    throw new Error("Expected action to reject with membership error context");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Expected action to reject with membership error context"
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/not a member of the chat, was blocked, or was kicked/i);
    expect(message).toMatch(expectedDetail);
    expect(message).toMatch(/Fix: Add the bot to the channel\/group/i);
    expect(message).toMatch(new RegExp(`chat_id=${expectedChatId}`));
  }
}

function mockLoadedMedia({
  buffer = Buffer.from("media"),
  contentType,
  fileName,
}: {
  buffer?: Buffer;
  contentType?: string;
  fileName?: string;
}): void {
  loadWebMedia.mockResolvedValueOnce({
    buffer,
    ...(contentType ? { contentType } : {}),
    ...(fileName ? { fileName } : {}),
  });
}

describe("sent-message-cache", () => {
  afterEach(() => {
    clearSentMessageCache();
  });

  it("records and retrieves sent messages", () => {
    recordSentMessage(123, 1);
    recordSentMessage(123, 2);
    recordSentMessage(456, 10);

    expect(wasSentByBot(123, 1)).toBe(true);
    expect(wasSentByBot(123, 2)).toBe(true);
    expect(wasSentByBot(456, 10)).toBe(true);
    expect(wasSentByBot(123, 3)).toBe(false);
    expect(wasSentByBot(789, 1)).toBe(false);
  });

  it("handles string chat IDs", () => {
    recordSentMessage("123", 1);
    expect(wasSentByBot("123", 1)).toBe(true);
    expect(wasSentByBot(123, 1)).toBe(true);
  });

  it("clears cache", () => {
    recordSentMessage(123, 1);
    expect(wasSentByBot(123, 1)).toBe(true);

    clearSentMessageCache();
    expect(wasSentByBot(123, 1)).toBe(false);
  });

  it("keeps sent-message ownership across restart", async () => {
    const persistedStorePath = `/tmp/openclaw-telegram-send-tests-${process.pid}-restart.json`;
    resolveStorePath.mockReturnValue(persistedStorePath);

    recordSentMessage(123, 1);
    expect(wasSentByBot(123, 1)).toBe(true);

    resetSentMessageCacheForTest();

    const restartedCache = await importFreshModule<typeof import("./sent-message-cache.js")>(
      import.meta.url,
      "./sent-message-cache.js?scope=restart",
    );

    try {
      expect(restartedCache.wasSentByBot(123, 1)).toBe(true);
    } finally {
      restartedCache.clearSentMessageCache();
    }
  });

  it("shares sent-message state across distinct module instances", async () => {
    const cacheA = await importFreshModule<typeof import("./sent-message-cache.js")>(
      import.meta.url,
      "./sent-message-cache.js?scope=shared-a",
    );
    const cacheB = await importFreshModule<typeof import("./sent-message-cache.js")>(
      import.meta.url,
      "./sent-message-cache.js?scope=shared-b",
    );

    cacheA.clearSentMessageCache();

    try {
      cacheA.recordSentMessage(123, 1);
      expect(cacheB.wasSentByBot(123, 1)).toBe(true);

      cacheB.clearSentMessageCache();
      expect(cacheA.wasSentByBot(123, 1)).toBe(false);
    } finally {
      cacheA.clearSentMessageCache();
    }
  });
});

describe("buildInlineKeyboard", () => {
  it("normalizes keyboard inputs", () => {
    const cases: {
      name: string;
      input: Parameters<typeof buildInlineKeyboard>[0];
      expected: ReturnType<typeof buildInlineKeyboard>;
    }[] = [
      {
        expected: undefined,
        input: undefined,
        name: "empty input",
      },
      {
        expected: undefined,
        input: [],
        name: "empty rows",
      },
      {
        expected: {
          inline_keyboard: [
            [{ callback_data: "cmd:a", text: "Option A" }],
            [
              { callback_data: "cmd:b", text: "Option B" },
              { callback_data: "cmd:c", text: "Option C" },
            ],
          ],
        },
        input: [
          [{ callback_data: "cmd:a", text: "Option A" }],
          [
            { callback_data: "cmd:b", text: "Option B" },
            { callback_data: "cmd:c", text: "Option C" },
          ],
        ],
        name: "valid rows",
      },
      {
        expected: {
          inline_keyboard: [
            [
              {
                callback_data: "cmd:a",
                style: "primary",
                text: "Option A",
              },
            ],
          ],
        },
        input: [
          [
            {
              callback_data: "cmd:a",
              style: "primary",
              text: "Option A",
            },
          ],
        ],
        name: "keeps button style fields",
      },
      {
        expected: {
          inline_keyboard: [[{ callback_data: "cmd:ok", text: "Ok" }]],
        },
        input: [
          [
            { callback_data: "cmd:skip", text: "" },
            { callback_data: "cmd:ok", text: "Ok" },
          ],
          [{ callback_data: "", text: "Missing data" }],
          [],
        ],
        name: "filters invalid buttons and empty rows",
      },
    ];
    for (const testCase of cases) {
      const input = testCase.input?.map((row) => row.map((button) => ({ ...button })));
      expect(buildInlineKeyboard(input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("sendMessageTelegram", () => {
  it("sends typing to the resolved chat and topic", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.sendChatAction.mockResolvedValue(true);

    await sendTypingTelegram("telegram:group:-1001234567890:topic:271", {
      accountId: "default",
    });

    expect(botApi.sendChatAction).toHaveBeenCalledWith("-1001234567890", "typing", {
      message_thread_id: 271,
    });
  });

  it("pins and unpins Telegram messages", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.pinChatMessage.mockResolvedValue(true);
    botApi.unpinChatMessage.mockResolvedValue(true);

    await pinMessageTelegram("-1001234567890", 101, { accountId: "default" });
    await unpinMessageTelegram("-1001234567890", 101, { accountId: "default" });

    expect(botApi.pinChatMessage).toHaveBeenCalledWith("-1001234567890", 101, {
      disable_notification: true,
    });
    expect(botApi.unpinChatMessage).toHaveBeenCalledWith("-1001234567890", 101);
  });

  it("renames a Telegram forum topic", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.editForumTopic.mockResolvedValue(true);

    await renameForumTopicTelegram("-1001234567890", 271, "Codex Thread", {
      accountId: "default",
    });

    expect(botApi.editForumTopic).toHaveBeenCalledWith("-1001234567890", 271, {
      name: "Codex Thread",
    });
  });

  it("edits a Telegram forum topic name and icon via the shared helper", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.editForumTopic.mockResolvedValue(true);

    await editForumTopicTelegram("-1001234567890", 271, {
      accountId: "default",
      iconCustomEmojiId: "emoji-123",
      name: "Codex Thread",
    });

    expect(botApi.editForumTopic).toHaveBeenCalledWith("-1001234567890", 271, {
      icon_custom_emoji_id: "emoji-123",
      name: "Codex Thread",
    });
  });

  it("strips topic suffixes before editing a Telegram forum topic", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.editForumTopic.mockResolvedValue(true);

    await editForumTopicTelegram("telegram:group:-1001234567890:topic:271", 271, {
      accountId: "default",
      name: "Codex Thread",
    });

    expect(botApi.editForumTopic).toHaveBeenCalledWith("-1001234567890", 271, {
      name: "Codex Thread",
    });
  });

  it("rejects empty topic edits", async () => {
    await expect(
      editForumTopicTelegram("-1001234567890", 271, {
        accountId: "default",
      }),
    ).rejects.toThrow("Telegram forum topic update requires a name or iconCustomEmojiId");
    await expect(
      editForumTopicTelegram("-1001234567890", 271, {
        accountId: "default",
        iconCustomEmojiId: "   ",
      }),
    ).rejects.toThrow("Telegram forum topic icon custom emoji ID is required");
  });

  it("applies timeoutSeconds config precedence", async () => {
    const cases = [
      {
        cfg: { channels: { telegram: { timeoutSeconds: 60 } } },
        expectedTimeout: 60,
        name: "global telegram timeout",
        opts: { token: "tok" },
      },
      {
        cfg: {
          channels: {
            telegram: {
              accounts: { foo: { timeoutSeconds: 61 } },
              timeoutSeconds: 60,
            },
          },
        },
        expectedTimeout: 61,
        name: "per-account timeout override",
        opts: { accountId: "foo", token: "tok" },
      },
    ] as const;
    for (const testCase of cases) {
      botCtorSpy.mockClear();
      loadConfig.mockReturnValue(testCase.cfg);
      botApi.sendMessage.mockResolvedValue({
        chat: { id: "123" },
        message_id: 1,
      });
      await sendMessageTelegram("123", "hi", testCase.opts);
      expect(botCtorSpy, testCase.name).toHaveBeenCalledWith(
        "tok",
        expect.objectContaining({
          client: expect.objectContaining({ timeoutSeconds: testCase.expectedTimeout }),
        }),
      );
    }
  });

  it("falls back to plain text when Telegram rejects HTML and preserves send params", async () => {
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const cases = [
      {
        chatId: "123",
        firstCall: { parse_mode: "HTML" },
        htmlText: "<i>oops</i>",
        messageId: 42,
        name: "plain text send",
        options: { verbose: true } as const,
        secondCall: undefined,
        text: "_oops_",
      },
      {
        chatId: "-1001234567890",
        firstCall: {
          allow_sending_without_reply: true,
          message_thread_id: 271,
          parse_mode: "HTML",
          reply_to_message_id: 100,
        },
        htmlText: "<i>bad markdown</i>",
        messageId: 60,
        name: "threaded reply send",
        options: { messageThreadId: 271, replyToMessageId: 100 } as const,
        secondCall: {
          allow_sending_without_reply: true,
          message_thread_id: 271,
          reply_to_message_id: 100,
        },
        text: "_bad markdown_",
      },
    ] as const;

    for (const testCase of cases) {
      const sendMessage = vi
        .fn()
        .mockRejectedValueOnce(parseErr)
        .mockResolvedValueOnce({
          chat: { id: testCase.chatId },
          message_id: testCase.messageId,
        });
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      const res = await sendMessageTelegram(testCase.chatId, testCase.text, {
        api,
        token: "tok",
        ...testCase.options,
      });

      expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
        1,
        testCase.chatId,
        testCase.htmlText,
        testCase.firstCall,
      );
      if (testCase.secondCall) {
        expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
          2,
          testCase.chatId,
          testCase.text,
          testCase.secondCall,
        );
      } else {
        expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
          2,
          testCase.chatId,
          testCase.text,
        );
      }
      expect(res.chatId, testCase.name).toBe(testCase.chatId);
      expect(res.messageId, testCase.name).toBe(String(testCase.messageId));
    }
  });

  it("keeps link_preview_options disabled for both html and plain-text fallback", async () => {
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const cases = [
      {
        expectedCalls: [
          ["123", "hi", { link_preview_options: { is_disabled: true }, parse_mode: "HTML" }],
        ],
        name: "html send succeeds",
        sendMessage: vi.fn().mockResolvedValue({ chat: { id: "123" }, message_id: 7 }),
        text: "hi",
      },
      {
        expectedCalls: [
          [
            "123",
            "<i>oops</i>",
            { link_preview_options: { is_disabled: true }, parse_mode: "HTML" },
          ],
          ["123", "_oops_", { link_preview_options: { is_disabled: true } }],
        ],
        name: "html parse fails then plain-text fallback",
        sendMessage: vi
          .fn()
          .mockRejectedValueOnce(parseErr)
          .mockResolvedValueOnce({ chat: { id: "123" }, message_id: 42 }),
        text: "_oops_",
      },
    ] as const;
    for (const testCase of cases) {
      loadConfig.mockReturnValue({
        channels: { telegram: { linkPreview: false } },
      });
      const api = { sendMessage: testCase.sendMessage } as unknown as {
        sendMessage: typeof testCase.sendMessage;
      };
      await sendMessageTelegram("123", testCase.text, { api, token: "tok" });
      expect(testCase.sendMessage.mock.calls, testCase.name).toEqual(testCase.expectedCalls);
    }
  });

  it("fails when Telegram text send returns no message_id", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "123" },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram("123", "hi", {
        api,
        token: "tok",
      }),
    ).rejects.toThrow(/returned no message_id/i);
  });

  it("fails when Telegram media send returns no message_id", async () => {
    mockLoadedMedia({ contentType: "image/png", fileName: "photo.png" });
    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: "123" },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    await expect(
      sendMessageTelegram("123", "caption", {
        api,
        mediaUrl: "https://example.com/photo.png",
        token: "tok",
      }),
    ).rejects.toThrow(/returned no message_id/i);
  });

  it("uses native fetch for BAN compatibility when api is omitted", async () => {
    const originalFetch = globalThis.fetch;
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    (globalThis as { Bun?: unknown }).Bun = {};
    botApi.sendMessage.mockResolvedValue({
      chat: { id: "123" },
      message_id: 1,
    });
    try {
      await sendMessageTelegram("123", "hi", { token: "tok" });
      const clientFetch = (botCtorSpy.mock.calls[0]?.[1] as { client?: { fetch?: unknown } })
        ?.client?.fetch;
      expect(clientFetch).toBeTypeOf("function");
      expect(clientFetch).not.toBe(fetchSpy);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBun === undefined) {
        delete (globalThis as { Bun?: unknown }).Bun;
      } else {
        (globalThis as { Bun?: unknown }).Bun = originalBun;
      }
    }
  });

  it("normalizes chat ids with internal prefixes", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "123" },
      message_id: 1,
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram("telegram:123", "hi", {
      api,
      token: "tok",
    });

    expect(sendMessage).toHaveBeenCalledWith("123", "hi", {
      parse_mode: "HTML",
    });
  });

  it("resolves t.me targets to numeric chat ids via getChat", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "-100123" },
      message_id: 1,
    });
    const getChat = vi.fn().mockResolvedValue({ id: -100_123 });
    const api = { getChat, sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
      getChat: typeof getChat;
    };

    await sendMessageTelegram("https://t.me/mychannel", "hi", {
      api,
      gatewayClientScopes: ["operator.write"],
      token: "tok",
    });

    expect(getChat).toHaveBeenCalledWith("@mychannel");
    expect(sendMessage).toHaveBeenCalledWith("-100123", "hi", {
      parse_mode: "HTML",
    });
    expect(maybePersistResolvedTelegramTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayClientScopes: ["operator.write"],
        rawTarget: "https://t.me/mychannel",
        resolvedChatId: "-100123",
      }),
    );
  });

  it("fails clearly when a legacy target cannot be resolved", async () => {
    const getChat = vi.fn().mockRejectedValue(new Error("400: Bad Request: chat not found"));
    const api = { getChat } as unknown as {
      getChat: typeof getChat;
    };

    await expect(
      sendMessageTelegram("@missingchannel", "hi", {
        api,
        token: "tok",
      }),
    ).rejects.toThrow(/could not be resolved to a numeric chat ID/i);
  });

  it("includes thread params in media messages", async () => {
    const chatId = "-1001234567890";
    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 58,
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo in topic", {
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 99,
      token: "tok",
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "photo in topic",
      message_thread_id: 99,
      parse_mode: "HTML",
    });
  });

  it("splits long captions into media + text messages when text exceeds 1024 chars", async () => {
    const chatId = "123";
    const longText = "A".repeat(1100);

    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 70,
    });
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 71,
    });
    const api = { sendMessage, sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, longText, {
      api,
      mediaUrl: "https://example.com/photo.jpg",
      token: "tok",
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: undefined,
    });
    expect(sendMessage).toHaveBeenCalledWith(chatId, longText, {
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("71");
  });

  it("uses caption when text is within 1024 char limit", async () => {
    const chatId = "123";
    const shortText = "B".repeat(1024);

    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 72,
    });
    const sendMessage = vi.fn();
    const api = { sendMessage, sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, shortText, {
      api,
      mediaUrl: "https://example.com/photo.jpg",
      token: "tok",
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: shortText,
      parse_mode: "HTML",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.messageId).toBe("72");
  });

  it("renders markdown in media captions", async () => {
    const chatId = "123";
    const caption = "hi **boss**";

    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 90,
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, caption, {
      api,
      mediaUrl: "https://example.com/photo.jpg",
      token: "tok",
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "hi <b>boss</b>",
      parse_mode: "HTML",
    });
  });

  it("sends video notes when requested and regular videos otherwise", async () => {
    const chatId = "123";

    {
      const text = "ignored caption context";
      const sendVideoNote = vi.fn().mockResolvedValue({
        chat: { id: chatId },
        message_id: 101,
      });
      const sendMessage = vi.fn().mockResolvedValue({
        chat: { id: chatId },
        message_id: 102,
      });
      const api = { sendMessage, sendVideoNote } as unknown as {
        sendVideoNote: typeof sendVideoNote;
        sendMessage: typeof sendMessage;
      };

      mockLoadedMedia({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const res = await sendMessageTelegram(chatId, text, {
        api,
        asVideoNote: true,
        mediaUrl: "https://example.com/video.mp4",
        token: "tok",
      });

      expect(sendVideoNote).toHaveBeenCalledWith(chatId, expect.anything(), {});
      expect(sendMessage).toHaveBeenCalledWith(chatId, text, {
        parse_mode: "HTML",
      });
      expect(res.messageId).toBe("102");
    }

    {
      const text = "my caption";
      const sendVideo = vi.fn().mockResolvedValue({
        chat: { id: chatId },
        message_id: 201,
      });
      const api = { sendVideo } as unknown as {
        sendVideo: typeof sendVideo;
      };

      mockLoadedMedia({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const res = await sendMessageTelegram(chatId, text, {
        api,
        asVideoNote: false,
        mediaUrl: "https://example.com/video.mp4",
        token: "tok",
      });

      expect(sendVideo).toHaveBeenCalledWith(chatId, expect.anything(), {
        caption: expect.any(String),
        parse_mode: "HTML",
      });
      expect(res.messageId).toBe("201");
    }
  });

  it("applies reply markup and thread options to split video-note sends", async () => {
    const chatId = "123";
    const cases: {
      text: string;
      options: Partial<NonNullable<Parameters<typeof sendMessageTelegram>[2]>>;
      expectedVideoNote: Record<string, unknown>;
      expectedMessage: Record<string, unknown>;
    }[] = [
      {
        expectedMessage: {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ callback_data: "dat", text: "Btn" }]],
          },
        },
        expectedVideoNote: {},
        options: {
          buttons: [[{ callback_data: "dat", text: "Btn" }]],
        },
        text: "Check this out",
      },
      {
        expectedMessage: {
          allow_sending_without_reply: true,
          parse_mode: "HTML",
          reply_to_message_id: 999,
        },
        expectedVideoNote: { allow_sending_without_reply: true, reply_to_message_id: 999 },
        options: {
          replyToMessageId: 999,
        },
        text: "Threaded reply",
      },
    ];

    for (const testCase of cases) {
      const sendVideoNote = vi.fn().mockResolvedValue({
        chat: { id: chatId },
        message_id: 301,
      });
      const sendMessage = vi.fn().mockResolvedValue({
        chat: { id: chatId },
        message_id: 302,
      });
      const api = { sendMessage, sendVideoNote } as unknown as {
        sendVideoNote: typeof sendVideoNote;
        sendMessage: typeof sendMessage;
      };

      mockLoadedMedia({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const sendOptions: NonNullable<Parameters<typeof sendMessageTelegram>[2]> = {
        api,
        asVideoNote: true,
        mediaUrl: "https://example.com/video.mp4",
        token: "tok",
      };
      if (
        "replyToMessageId" in testCase.options &&
        testCase.options.replyToMessageId !== undefined
      ) {
        sendOptions.replyToMessageId = testCase.options.replyToMessageId;
      }
      if ("buttons" in testCase.options && testCase.options.buttons) {
        sendOptions.buttons = testCase.options.buttons;
      }
      await sendMessageTelegram(chatId, testCase.text, sendOptions);

      expect(sendVideoNote).toHaveBeenCalledWith(
        chatId,
        expect.anything(),
        testCase.expectedVideoNote,
      );
      expect(sendMessage).toHaveBeenCalledWith(chatId, testCase.text, testCase.expectedMessage);
    }
  });

  it("retries pre-connect send errors and honors retry_after when present", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), {
      code: "ENOTFOUND",
      parameters: { retry_after: 0.5 },
    });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        chat: { id: chatId },
        message_id: 1,
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const promise = sendMessageTelegram(chatId, "hi", {
      api,
      retry: { attempts: 2, jitter: 0, maxDelayMs: 1000, minDelayMs: 0 },
      token: "tok",
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ chatId, messageId: "1" });
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(500);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("retries wrapped pre-connect HttpError sends", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const root = Object.assign(new Error("connect ECONNREFUSED api.telegram.org"), {
      code: "ECONNREFUSED",
    });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause: root });
    const err = Object.assign(new Error("Network request for 'sendMessage' failed!"), {
      error: fetchError,
      name: "HttpError",
    });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        chat: { id: chatId },
        message_id: 1,
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const promise = sendMessageTelegram(chatId, "hi", {
      api,
      retry: { attempts: 2, jitter: 0, maxDelayMs: 1000, minDelayMs: 0 },
      token: "tok",
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ chatId, messageId: "1" });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not retry on non-transient errors", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockRejectedValue(new Error("400: Bad Request"));
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hi", {
        api,
        retry: { attempts: 3, jitter: 0, maxDelayMs: 0, minDelayMs: 0 },
        token: "tok",
      }),
    ).rejects.toThrow(/Bad Request/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not retry generic grammY failed-after envelopes for non-idempotent sends", async () => {
    const chatId = "123";
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Network request for 'sendMessage' failed after 1 attempts."),
      );
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hi", {
        api,
        retry: { attempts: 2, jitter: 0, maxDelayMs: 0, minDelayMs: 0 },
        token: "tok",
      }),
    ).rejects.toThrow(/failed after 1 attempts/i);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends GIF media as animation", async () => {
    const chatId = "123";
    const sendAnimation = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 9,
    });
    const api = { sendAnimation } as unknown as {
      sendAnimation: typeof sendAnimation;
    };

    mockLoadedMedia({
      buffer: Buffer.from("GIF89a"),
      fileName: "fun.gif",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      api,
      mediaUrl: "https://example.com/fun",
      token: "tok",
    });

    expect(sendAnimation).toHaveBeenCalledTimes(1);
    expect(sendAnimation).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("9");
  });

  it.each([
    {
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      fileName: "photo.png",
      mediaUrl: "https://example.com/photo.png",
      name: "images",
    },
    {
      buffer: Buffer.from("GIF89a"),
      contentType: "image/gif",
      fileName: "fun.gif",
      mediaUrl: "https://example.com/fun.gif",
      name: "GIFs",
    },
  ])("sends $name as documents when forceDocument is true", async (testCase) => {
    const chatId = "123";
    const sendAnimation = vi.fn();
    const sendDocument = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 10,
    });
    const sendPhoto = vi.fn();
    const api = { sendAnimation, sendDocument, sendPhoto } as unknown as {
      sendAnimation: typeof sendAnimation;
      sendDocument: typeof sendDocument;
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: testCase.buffer,
      contentType: testCase.contentType,
      fileName: testCase.fileName,
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      api,
      forceDocument: true,
      mediaUrl: testCase.mediaUrl,
      token: "tok",
    });

    expect(sendDocument, testCase.name).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      disable_content_type_detection: true,
      parse_mode: "HTML",
    });
    expect(sendPhoto, testCase.name).not.toHaveBeenCalled();
    expect(sendAnimation, testCase.name).not.toHaveBeenCalled();
    expect(res.messageId).toBe("10");
  });

  it.each([
    { height: 5001, name: "oversized dimensions", width: 6000 },
    { height: 100, name: "oversized aspect ratio", width: 4000 },
  ])("sends images as documents when Telegram rejects $name", async ({ width, height }) => {
    const chatId = "123";
    const sendDocument = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 10,
    });
    const sendPhoto = vi.fn();
    const api = { sendDocument, sendPhoto } as unknown as {
      sendDocument: typeof sendDocument;
      sendPhoto: typeof sendPhoto;
    };

    imageMetadata.width = width;
    imageMetadata.height = height;
    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      fileName: "photo.png",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      api,
      mediaUrl: "https://example.com/photo.png",
      token: "tok",
    });

    expect(sendDocument).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(res.messageId).toBe("10");
  });

  it("sends images as documents when metadata dimensions are unavailable", async () => {
    const chatId = "123";
    const sendDocument = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 10,
    });
    const sendPhoto = vi.fn();
    const api = { sendDocument, sendPhoto } as unknown as {
      sendDocument: typeof sendDocument;
      sendPhoto: typeof sendPhoto;
    };

    imageMetadata.width = undefined;
    imageMetadata.height = undefined;
    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      fileName: "photo.png",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      api,
      mediaUrl: "https://example.com/photo.png",
      token: "tok",
    });

    expect(sendDocument).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(res.messageId).toBe("10");
  });

  it("keeps regular document sends on the default Telegram params", async () => {
    const chatId = "123";
    const sendDocument = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 11,
    });
    const api = { sendDocument } as unknown as {
      sendDocument: typeof sendDocument;
    };

    mockLoadedMedia({
      buffer: Buffer.from("%PDF-1.7"),
      contentType: "application/pdf",
      fileName: "report.pdf",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      api,
      mediaUrl: "https://example.com/report.pdf",
      token: "tok",
    });

    expect(sendDocument).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("11");
  });

  it("routes audio media to sendAudio/sendVoice based on voice compatibility", async () => {
    const cases: {
      name: string;
      chatId: string;
      text: string;
      mediaUrl: string;
      contentType: string;
      fileName: string;
      asVoice?: boolean;
      messageThreadId?: number;
      replyToMessageId?: number;
      expectedMethod: "sendAudio" | "sendVoice";
      expectedOptions: Record<string, unknown>;
    }[] = [
      {
        chatId: "123",
        contentType: "audio/mpeg",
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
        fileName: "clip.mp3",
        mediaUrl: "https://example.com/clip.mp3",
        name: "default audio send",
        text: "caption",
      },
      {
        asVoice: true,
        chatId: "-1001234567890",
        contentType: "audio/ogg",
        expectedMethod: "sendVoice" as const,
        expectedOptions: {
          allow_sending_without_reply: true,
          caption: "voice note",
          message_thread_id: 271,
          parse_mode: "HTML",
          reply_to_message_id: 500,
        },
        fileName: "note.ogg",
        mediaUrl: "https://example.com/note.ogg",
        messageThreadId: 271,
        name: "voice-compatible media with thread params",
        replyToMessageId: 500,
        text: "voice note",
      },
      {
        asVoice: true,
        chatId: "123",
        contentType: "audio/wav",
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
        fileName: "clip.wav",
        mediaUrl: "https://example.com/clip.wav",
        name: "asVoice fallback for non-voice media",
        text: "caption",
      },
      {
        asVoice: true,
        chatId: "123",
        contentType: "audio/mpeg",
        expectedMethod: "sendVoice" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
        fileName: "clip.mp3",
        mediaUrl: "https://example.com/clip.mp3",
        name: "asVoice accepts mp3",
        text: "caption",
      },
      {
        chatId: "123",
        contentType: " Audio/Ogg; codecs=opus ",
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
        fileName: "note.ogg",
        mediaUrl: "https://example.com/note",
        name: "normalizes parameterized audio MIME with mixed casing",
        text: "caption",
      },
    ];

    for (const testCase of cases) {
      const sendAudio = vi.fn().mockResolvedValue({
        chat: { id: testCase.chatId },
        message_id: 10,
      });
      const sendVoice = vi.fn().mockResolvedValue({
        chat: { id: testCase.chatId },
        message_id: 11,
      });
      const api = { sendAudio, sendVoice } as unknown as {
        sendAudio: typeof sendAudio;
        sendVoice: typeof sendVoice;
      };

      mockLoadedMedia({
        buffer: Buffer.from("audio"),
        contentType: testCase.contentType,
        fileName: testCase.fileName,
      });

      await sendMessageTelegram(testCase.chatId, testCase.text, {
        api,
        mediaUrl: testCase.mediaUrl,
        token: "tok",
        ...("asVoice" in testCase && testCase.asVoice ? { asVoice: true } : {}),
        ...("messageThreadId" in testCase && testCase.messageThreadId !== undefined
          ? { messageThreadId: testCase.messageThreadId }
          : {}),
        ...("replyToMessageId" in testCase && testCase.replyToMessageId !== undefined
          ? { replyToMessageId: testCase.replyToMessageId }
          : {}),
      });

      const called = testCase.expectedMethod === "sendVoice" ? sendVoice : sendAudio;
      const notCalled = testCase.expectedMethod === "sendVoice" ? sendAudio : sendVoice;
      expect(called, testCase.name).toHaveBeenCalledWith(
        testCase.chatId,
        expect.anything(),
        testCase.expectedOptions,
      );
      expect(notCalled, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("keeps message_thread_id for forum/private/group sends", async () => {
    const cases = [
      {
        chatId: "-1001234567890",
        messageId: 55,
        name: "forum topic",
        text: "hello forum",
      },
      {
        chatId: "123456789",
        messageId: 56,
        name: "private chat topic (#18974)",
        text: "hello private",
      },
      {
        // Group/supergroup chats have negative IDs.
        chatId: "-1001234567890",
        messageId: 57,
        name: "group chat (#17242)",
        text: "hello group",
      },
    ] as const;

    for (const testCase of cases) {
      const sendMessage = vi.fn().mockResolvedValue({
        chat: { id: testCase.chatId },
        message_id: testCase.messageId,
      });
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      await sendMessageTelegram(testCase.chatId, testCase.text, {
        api,
        messageThreadId: 271,
        token: "tok",
      });

      expect(sendMessage, testCase.name).toHaveBeenCalledWith(testCase.chatId, testCase.text, {
        message_thread_id: 271,
        parse_mode: "HTML",
      });
    }
  });

  it("retries sends without message_thread_id on thread-not-found", async () => {
    const cases = [
      { chatId: "-100123", messageId: 58, name: "forum", text: "hello forum" },
      { chatId: "123456789", messageId: 59, name: "private", text: "hello private" },
    ] as const;
    const threadErr = new Error("400: Bad Request: message thread not found");

    for (const testCase of cases) {
      const sendMessage = vi
        .fn()
        .mockRejectedValueOnce(threadErr)
        .mockResolvedValueOnce({
          chat: { id: testCase.chatId },
          message_id: testCase.messageId,
        });
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      const res = await sendMessageTelegram(testCase.chatId, testCase.text, {
        api,
        messageThreadId: 271,
        token: "tok",
      });

      expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
        1,
        testCase.chatId,
        testCase.text,
        {
          message_thread_id: 271,
          parse_mode: "HTML",
        },
      );
      expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
        2,
        testCase.chatId,
        testCase.text,
        {
          parse_mode: "HTML",
        },
      );
      expect(res.messageId, testCase.name).toBe(String(testCase.messageId));
    }
  });

  it("does not retry on non-retriable thread/chat errors", async () => {
    const cases: {
      chatId: string;
      text: string;
      error: Error;
      opts?: { messageThreadId?: number };
      expectedError: RegExp | string;
      expectedCallArgs: [string, string, { parse_mode: "HTML"; message_thread_id?: number }];
    }[] = [
      {
        chatId: "123",
        error: new Error("400: Bad Request: message thread not found"),
        expectedCallArgs: ["123", "hello forum", { parse_mode: "HTML" }],
        expectedError: "message thread not found",
        text: "hello forum",
      },
      {
        chatId: "123456789",
        error: new Error("400: Bad Request: chat not found"),
        expectedCallArgs: [
          "123456789",
          "hello private",
          { message_thread_id: 271, parse_mode: "HTML" },
        ],
        expectedError: /chat not found/i,
        opts: { messageThreadId: 271 },
        text: "hello private",
      },
    ];

    for (const testCase of cases) {
      const sendMessage = vi.fn().mockRejectedValueOnce(testCase.error);
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      await expect(
        sendMessageTelegram(testCase.chatId, testCase.text, {
          api,
          token: "tok",
          ...testCase.opts,
        }),
      ).rejects.toThrow(testCase.expectedError);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(...testCase.expectedCallArgs);
    }
  });

  it("sets disable_notification when silent is true", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 1,
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "hi", {
      api,
      silent: true,
      token: "tok",
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hi", {
      disable_notification: true,
      parse_mode: "HTML",
    });
  });

  it("keeps disable_notification on plain-text fallback when silent is true", async () => {
    const chatId = "123";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({ chat: { id: chatId }, message_id: 2 });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "_oops_", {
      api,
      silent: true,
      token: "tok",
    });

    expect(sendMessage.mock.calls).toEqual([
      [chatId, "<i>oops</i>", { disable_notification: true, parse_mode: "HTML" }],
      [chatId, "_oops_", { disable_notification: true }],
    ]);
  });

  it("parses message_thread_id from recipient string (telegram:group:...:topic:...)", async () => {
    const chatId = "-1001234567890";
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 55,
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(`telegram:group:${chatId}:topic:271`, "hello forum", {
      api,
      token: "tok",
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hello forum", {
      message_thread_id: 271,
      parse_mode: "HTML",
    });
  });

  it("retries media sends without message_thread_id when thread is missing", async () => {
    const chatId = "-100123";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendPhoto = vi
      .fn()
      .mockRejectedValueOnce(threadErr)
      .mockResolvedValueOnce({
        chat: { id: chatId },
        message_id: 59,
      });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, "photo", {
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 271,
      token: "tok",
    });

    expect(sendPhoto).toHaveBeenNthCalledWith(1, chatId, expect.anything(), {
      caption: "photo",
      message_thread_id: 271,
      parse_mode: "HTML",
    });
    expect(sendPhoto).toHaveBeenNthCalledWith(2, chatId, expect.anything(), {
      caption: "photo",
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("59");
  });

  it("defaults outbound media uploads to 100MB", async () => {
    const chatId = "123";
    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 60,
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo", {
      api,
      mediaUrl: "https://example.com/photo.jpg",
      token: "tok",
    });

    expect(loadWebMedia).toHaveBeenCalledWith(
      "https://example.com/photo.jpg",
      expect.objectContaining({ maxBytes: 100 * 1024 * 1024 }),
    );
  });

  it("uses configured telegram mediaMaxMb for outbound uploads", async () => {
    const chatId = "123";
    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: chatId },
      message_id: 61,
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          mediaMaxMb: 42,
        },
      },
    });

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo", {
      api,
      mediaUrl: "https://example.com/photo.jpg",
      token: "tok",
    });

    expect(loadWebMedia).toHaveBeenCalledWith(
      "https://example.com/photo.jpg",
      expect.objectContaining({ maxBytes: 42 * 1024 * 1024 }),
    );
  });

  it("chunks long html-mode text and keeps buttons on the last chunk only", async () => {
    const chatId = "123";
    const htmlText = `<b>${"A".repeat(5000)}</b>`;

    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ chat: { id: chatId }, message_id: 90 })
      .mockResolvedValueOnce({ chat: { id: chatId }, message_id: 91 });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, htmlText, {
      api,
      buttons: [[{ callback_data: "ok", text: "OK" }]],
      textMode: "html",
      token: "tok",
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const firstCall = sendMessage.mock.calls[0];
    const secondCall = sendMessage.mock.calls[1];
    expect(firstCall).toBeDefined();
    expect(secondCall).toBeDefined();
    expect((firstCall[1] as string).length).toBeLessThanOrEqual(4000);
    expect((secondCall[1] as string).length).toBeLessThanOrEqual(4000);
    expect(firstCall[2]?.reply_markup).toBeUndefined();
    expect(secondCall[2]?.reply_markup).toEqual({
      inline_keyboard: [[{ callback_data: "ok", text: "OK" }]],
    });
    expect(res.messageId).toBe("91");
  });

  it("preserves caller plain-text fallback across chunked html parse retries", async () => {
    const chatId = "123";
    const htmlText = `<b>${"A".repeat(5000)}</b>`;
    const plainText = `${"P".repeat(2500)}${"Q".repeat(2500)}`;
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({ chat: { id: chatId }, message_id: 90 })
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({ chat: { id: chatId }, message_id: 91 });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, htmlText, {
      api,
      plainText,
      textMode: "html",
      token: "tok",
    });

    expect(sendMessage).toHaveBeenCalledTimes(4);
    const plainFallbackCalls = [sendMessage.mock.calls[1], sendMessage.mock.calls[3]];
    expect(plainFallbackCalls.map((call) => String(call?.[1] ?? "")).join("")).toBe(plainText);
    expect(plainFallbackCalls.every((call) => !String(call?.[1] ?? "").includes("<"))).toBe(true);
    expect(res.messageId).toBe("91");
  });

  it("keeps malformed leading ampersands on the chunked plain-text fallback path", async () => {
    const chatId = "123";
    const htmlText = `&${"A".repeat(5000)}`;
    const plainText = "fallback!!";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 0",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({ chat: { id: chatId }, message_id: 92 })
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({ chat: { id: chatId }, message_id: 93 });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, htmlText, {
      api,
      plainText,
      textMode: "html",
      token: "tok",
    });

    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(String(sendMessage.mock.calls[0]?.[1] ?? "")).toMatch(/^&/);
    const plainFallbackCalls = [sendMessage.mock.calls[1], sendMessage.mock.calls[3]];
    expect(plainFallbackCalls.map((call) => String(call?.[1] ?? "")).join("")).toBe(plainText);
    expect(plainFallbackCalls.every((call) => String(call?.[1] ?? "").length > 0)).toBe(true);
    expect(res.messageId).toBe("93");
  });

  it("cuts over to plain text when fallback text needs more chunks than html", async () => {
    const chatId = "123";
    const htmlText = `<b>${"A".repeat(5000)}</b>`;
    const plainText = "P".repeat(9000);
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ chat: { id: chatId }, message_id: 94 })
      .mockResolvedValueOnce({ chat: { id: chatId }, message_id: 95 })
      .mockResolvedValueOnce({ chat: { id: chatId }, message_id: 96 });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, htmlText, {
      api,
      plainText,
      textMode: "html",
      token: "tok",
    });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls.every((call) => call[2]?.parse_mode === undefined)).toBe(true);
    expect(sendMessage.mock.calls.map((call) => String(call[1] ?? "")).join("")).toBe(plainText);
    expect(res.messageId).toBe("96");
  });
});

describe("reactMessageTelegram", () => {
  it.each([
    {
      emoji: "✅",
      expected: [{ emoji: "✅", type: "emoji" }],
      messageId: "456",
      remove: false,
      target: "telegram:123",
      testName: "sends emoji reactions",
    },
    {
      emoji: "",
      expected: [],
      messageId: 456,
      remove: false,
      target: "123",
      testName: "removes reactions when emoji is empty",
    },
    {
      emoji: "✅",
      expected: [],
      messageId: 456,
      remove: true,
      target: "123",
      testName: "removes reactions when remove flag is set",
    },
  ] as const)("$testName", async (testCase) => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram(testCase.target, testCase.messageId, testCase.emoji, {
      api,
      token: "tok",
      ...(testCase.remove ? { remove: true } : {}),
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, testCase.expected);
  });

  it("resolves legacy telegram targets before reacting", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const getChat = vi.fn().mockResolvedValue({ id: -100_123 });
    const api = { getChat, setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
      getChat: typeof getChat;
    };

    await reactMessageTelegram("@mychannel", 456, "✅", {
      api,
      token: "tok",
    });

    expect(getChat).toHaveBeenCalledWith("@mychannel");
    expect(setMessageReaction).toHaveBeenCalledWith("-100123", 456, [
      { emoji: "✅", type: "emoji" },
    ]);
    expect(maybePersistResolvedTelegramTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        rawTarget: "@mychannel",
        resolvedChatId: "-100123",
      }),
    );
  });
});

describe("sendStickerTelegram", () => {
  const positiveSendCases = [
    {
      expectedFileId: "CAACAgIAAxkBAAI...sticker_file_id",
      expectedMessageId: 100,
      fileId: "CAACAgIAAxkBAAI...sticker_file_id",
      name: "sends a sticker by file_id",
    },
    {
      expectedFileId: "fileId123",
      expectedMessageId: 106,
      fileId: "  fileId123  ",
      name: "trims whitespace from fileId",
    },
  ] as const;

  for (const testCase of positiveSendCases) {
    it(testCase.name, async () => {
      const chatId = "123";
      const sendSticker = vi.fn().mockResolvedValue({
        chat: { id: chatId },
        message_id: testCase.expectedMessageId,
      });
      const api = { sendSticker } as unknown as {
        sendSticker: typeof sendSticker;
      };

      const res = await sendStickerTelegram(chatId, testCase.fileId, {
        api,
        token: "tok",
      });

      expect(sendSticker).toHaveBeenCalledWith(chatId, testCase.expectedFileId, undefined);
      expect(res.messageId).toBe(String(testCase.expectedMessageId));
      expect(res.chatId).toBe(chatId);
    });
  }

  it("throws error when fileId is blank", async () => {
    for (const fileId of ["", "   "]) {
      await expect(sendStickerTelegram("123", fileId, { token: "tok" })).rejects.toThrow(
        /file_id is required/i,
      );
    }
  });

  it("retries sticker sends without message_thread_id when thread is missing", async () => {
    const chatId = "-100123";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendSticker = vi
      .fn()
      .mockRejectedValueOnce(threadErr)
      .mockResolvedValueOnce({
        chat: { id: chatId },
        message_id: 109,
      });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    const res = await sendStickerTelegram(chatId, "fileId123", {
      api,
      messageThreadId: 271,
      token: "tok",
    });

    expect(sendSticker).toHaveBeenNthCalledWith(1, chatId, "fileId123", {
      message_thread_id: 271,
    });
    expect(sendSticker).toHaveBeenNthCalledWith(2, chatId, "fileId123", undefined);
    expect(res.messageId).toBe("109");
  });

  it("fails when sticker send returns no message_id", async () => {
    const chatId = "123";
    const sendSticker = vi.fn().mockResolvedValue({
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await expect(
      sendStickerTelegram(chatId, "fileId123", {
        api,
        token: "tok",
      }),
    ).rejects.toThrow(/returned no message_id/i);
  });

  it("does not retry generic grammY failed envelopes for sticker sends", async () => {
    const chatId = "123";
    const sendSticker = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network request for 'sendSticker' failed!"));
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await expect(
      sendStickerTelegram(chatId, "fileId123", {
        api,
        retry: { attempts: 2, jitter: 0, maxDelayMs: 0, minDelayMs: 0 },
        token: "tok",
      }),
    ).rejects.toThrow(/Network request for 'sendSticker' failed!/i);
    expect(sendSticker).toHaveBeenCalledTimes(1);
  });

  it("retries rate-limited sticker sends and honors retry_after", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const sendSticker = vi
      .fn()
      .mockRejectedValueOnce({
        message: "429 Too Many Requests",
        response: { parameters: { retry_after: 1 } },
      })
      .mockResolvedValueOnce({
        chat: { id: chatId },
        message_id: 109,
      });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const promise = sendStickerTelegram(chatId, "fileId123", {
      api,
      retry: { attempts: 2, jitter: 0, maxDelayMs: 1000, minDelayMs: 0 },
      token: "tok",
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ chatId, messageId: "109" });
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(1000);
    expect(sendSticker).toHaveBeenCalledTimes(2);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("shared send behaviors", () => {
  it("includes reply_to_message_id for threaded replies", async () => {
    const cases = [
      {
        name: "message send",
        run: async () => {
          const chatId = "123";
          const sendMessage = vi.fn().mockResolvedValue({
            chat: { id: chatId },
            message_id: 56,
          });
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await sendMessageTelegram(chatId, "reply text", {
            api,
            replyToMessageId: 100,
            token: "tok",
          });
          expect(sendMessage).toHaveBeenCalledWith(chatId, "reply text", {
            allow_sending_without_reply: true,
            parse_mode: "HTML",
            reply_to_message_id: 100,
          });
        },
      },
      {
        name: "sticker send",
        run: async () => {
          const chatId = "123";
          const fileId = "CAACAgIAAxkBAAI...sticker_file_id";
          const sendSticker = vi.fn().mockResolvedValue({
            chat: { id: chatId },
            message_id: 102,
          });
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await sendStickerTelegram(chatId, fileId, {
            api,
            replyToMessageId: 500,
            token: "tok",
          });
          expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, {
            allow_sending_without_reply: true,
            reply_to_message_id: 500,
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });

  it("omits invalid reply_to_message_id values before calling Telegram", async () => {
    const invalidReplyToMessageIds = ["session-meta-id", "123abc", Number.NaN] as const;

    for (const invalidReplyToMessageId of invalidReplyToMessageIds) {
      const chatId = "123";
      const sendMessage = vi.fn().mockResolvedValue({
        chat: { id: chatId },
        message_id: 56,
      });
      const sendSticker = vi.fn().mockResolvedValue({
        chat: { id: chatId },
        message_id: 102,
      });
      const api = { sendMessage, sendSticker } as unknown as {
        sendMessage: typeof sendMessage;
        sendSticker: typeof sendSticker;
      };

      await sendMessageTelegram(chatId, "reply text", {
        api,
        replyToMessageId: invalidReplyToMessageId as unknown as number,
        token: "tok",
      });
      await sendStickerTelegram(chatId, "CAACAgIAAxkBAAI...sticker_file_id", {
        api,
        replyToMessageId: invalidReplyToMessageId as unknown as number,
        token: "tok",
      });

      expect(sendMessage, String(invalidReplyToMessageId)).toHaveBeenCalledWith(
        chatId,
        "reply text",
        {
          parse_mode: "HTML",
        },
      );
      expect(sendSticker, String(invalidReplyToMessageId)).toHaveBeenCalledWith(
        chatId,
        "CAACAgIAAxkBAAI...sticker_file_id",
        undefined,
      );
    }
  });

  it("wraps chat-not-found with actionable context", async () => {
    const cases = [
      {
        name: "message send",
        run: async () => {
          const chatId = "123";
          const err = new Error("400: Bad Request: chat not found");
          const sendMessage = vi.fn().mockRejectedValue(err);
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await expectChatNotFoundWithChatId(
            sendMessageTelegram(chatId, "hi", { api, token: "tok" }),
            chatId,
          );
        },
      },
      {
        name: "sticker send",
        run: async () => {
          const chatId = "123";
          const err = new Error("400: Bad Request: chat not found");
          const sendSticker = vi.fn().mockRejectedValue(err);
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await expectChatNotFoundWithChatId(
            sendStickerTelegram(chatId, "fileId123", { api, token: "tok" }),
            chatId,
          );
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });

  it("wraps membership-related 403 errors with actionable context and original detail", async () => {
    const cases = [
      {
        errorText: "403: Forbidden: bot is not a member of the channel chat",
        name: "message send",
        run: async (chatId: string, err: Error) => {
          const sendMessage = vi.fn().mockRejectedValue(err);
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await expectTelegramMembershipErrorWithChatId(
            sendMessageTelegram(chatId, "hi", { api, token: "tok" }),
            chatId,
            /bot is not a member of the channel chat/i,
          );
        },
      },
      {
        errorText: "403: Forbidden: bot was kicked from the group chat",
        name: "sticker send",
        run: async (chatId: string, err: Error) => {
          const sendSticker = vi.fn().mockRejectedValue(err);
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await expectTelegramMembershipErrorWithChatId(
            sendStickerTelegram(chatId, "fileId123", { api, token: "tok" }),
            chatId,
            /bot was kicked from the group chat/i,
          );
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run("123", new Error(testCase.errorText));
    }
  });
});

describe("editMessageTelegram", () => {
  it.each([
    {
      buttons: undefined as Parameters<typeof buildInlineKeyboard>[0],
      expectedCalls: 1,
      firstExpectNoReplyMarkup: true,
      name: "buttons undefined keeps existing keyboard",
      parseFallback: false,
      text: "hi",
    },
    {
      buttons: [] as Parameters<typeof buildInlineKeyboard>[0],
      expectedCalls: 1,
      firstExpectReplyMarkup: { inline_keyboard: [] } as Record<string, unknown>,
      name: "buttons empty clears keyboard",
      parseFallback: false,
      text: "hi",
    },
    {
      buttons: [] as Parameters<typeof buildInlineKeyboard>[0],
      expectedCalls: 2,
      firstExpectReplyMarkup: { inline_keyboard: [] } as Record<string, unknown>,
      name: "parse error fallback preserves cleared keyboard",
      parseFallback: true,
      secondExpectReplyMarkup: { inline_keyboard: [] } as Record<string, unknown>,
      text: "<bad> html",
    },
  ])("$name", async (testCase) => {
    if (testCase.parseFallback) {
      botApi.editMessageText
        .mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities"))
        .mockResolvedValueOnce({ chat: { id: "123" }, message_id: 1 });
    } else {
      botApi.editMessageText.mockResolvedValue({ chat: { id: "123" }, message_id: 1 });
    }

    await editMessageTelegram("123", 1, testCase.text, {
      buttons: testCase.buttons ? testCase.buttons.map((row) => [...row]) : testCase.buttons,
      cfg: {},
      token: "tok",
    });

    expect(botCtorSpy, testCase.name).toHaveBeenCalledTimes(1);
    expect(botCtorSpy.mock.calls[0]?.[0], testCase.name).toBe("tok");
    expect(botApi.editMessageText, testCase.name).toHaveBeenCalledTimes(testCase.expectedCalls);

    const firstParams = (botApi.editMessageText.mock.calls[0] ?? [])[3] as Record<string, unknown>;
    expect(firstParams, testCase.name).toEqual(expect.objectContaining({ parse_mode: "HTML" }));
    if ("firstExpectNoReplyMarkup" in testCase && testCase.firstExpectNoReplyMarkup) {
      expect(firstParams, testCase.name).not.toHaveProperty("reply_markup");
    }
    if ("firstExpectReplyMarkup" in testCase && testCase.firstExpectReplyMarkup) {
      expect(firstParams, testCase.name).toEqual(
        expect.objectContaining({ reply_markup: testCase.firstExpectReplyMarkup }),
      );
    }

    if ("secondExpectReplyMarkup" in testCase && testCase.secondExpectReplyMarkup) {
      const secondParams = (botApi.editMessageText.mock.calls[1] ?? [])[3] as Record<
        string,
        unknown
      >;
      expect(secondParams, testCase.name).toEqual(
        expect.objectContaining({ reply_markup: testCase.secondExpectReplyMarkup }),
      );
    }
  });

  it("treats 'message is not modified' as success", async () => {
    botApi.editMessageText.mockRejectedValueOnce(
      new Error(
        "400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      ),
    );

    await expect(
      editMessageTelegram("123", 1, "hi", {
        cfg: {},
        token: "tok",
      }),
    ).resolves.toEqual({ chatId: "123", messageId: "1", ok: true });
    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
  });

  it("retries editMessageTelegram on Telegram 5xx errors", async () => {
    botApi.editMessageText
      .mockRejectedValueOnce(Object.assign(new Error("502: Bad Gateway"), { error_code: 502 }))
      .mockResolvedValueOnce({ chat: { id: "123" }, message_id: 1 });

    await expect(
      editMessageTelegram("123", 1, "hi", {
        cfg: {},
        retry: { attempts: 2, jitter: 0, maxDelayMs: 0, minDelayMs: 0 },
        token: "tok",
      }),
    ).resolves.toEqual({ chatId: "123", messageId: "1", ok: true });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(2);
  });

  it("disables link previews when linkPreview is false", async () => {
    botApi.editMessageText.mockResolvedValue({ chat: { id: "123" }, message_id: 1 });

    await editMessageTelegram("123", 1, "https://example.com", {
      cfg: {},
      linkPreview: false,
      token: "tok",
    });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const params = (botApi.editMessageText.mock.calls[0] ?? [])[3] as Record<string, unknown>;
    expect(params).toEqual(
      expect.objectContaining({
        link_preview_options: { is_disabled: true },
        parse_mode: "HTML",
      }),
    );
  });
});

describe("sendPollTelegram", () => {
  it("propagates gateway client scopes when resolving legacy poll targets", async () => {
    const api = {
      getChat: vi.fn(async () => ({ id: -100_321 })),
      sendPoll: vi.fn(async () => ({ chat: { id: 555 }, message_id: 123, poll: { id: "p1" } })),
    };

    await sendPollTelegram(
      "https://t.me/mychannel",
      { options: [" A ", "B "], question: " Q " },
      {
        api: api as unknown as Bot["api"],
        gatewayClientScopes: ["operator.admin"],
        token: "t",
      },
    );

    expect(api.getChat).toHaveBeenCalledWith("@mychannel");
    expect(maybePersistResolvedTelegramTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayClientScopes: ["operator.admin"],
        rawTarget: "https://t.me/mychannel",
        resolvedChatId: "-100321",
      }),
    );
  });

  it("maps durationSeconds to open_period", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ chat: { id: 555 }, message_id: 123, poll: { id: "p1" } })),
    };

    const res = await sendPollTelegram(
      "123",
      { durationSeconds: 60, options: [" A ", "B "], question: " Q " },
      { api: api as unknown as Bot["api"], token: "t" },
    );

    expect(res).toEqual({ chatId: "555", messageId: "123", pollId: "p1" });
    expect(api.sendPoll).toHaveBeenCalledTimes(1);
    const sendPollMock = api.sendPoll as ReturnType<typeof vi.fn>;
    expect(sendPollMock.mock.calls[0]?.[0]).toBe("123");
    expect(sendPollMock.mock.calls[0]?.[1]).toBe("Q");
    expect(sendPollMock.mock.calls[0]?.[2]).toEqual(["A", "B"]);
    expect(sendPollMock.mock.calls[0]?.[3]).toMatchObject({ open_period: 60 });
  });

  it("retries without message_thread_id on thread-not-found", async () => {
    const api = {
      sendPoll: vi.fn(
        async (_chatId: string, _question: string, _options: string[], params: unknown) => {
          const p = params as { message_thread_id?: unknown } | undefined;
          if (p?.message_thread_id) {
            throw new Error("400: Bad Request: message thread not found");
          }
          return { chat: { id: 2 }, message_id: 1, poll: { id: "p2" } };
        },
      ),
    };

    const res = await sendPollTelegram(
      "-100123",
      { options: ["A", "B"], question: "Q" },
      { api: api as unknown as Bot["api"], messageThreadId: 99, token: "t" },
    );

    expect(res).toEqual({ chatId: "2", messageId: "1", pollId: "p2" });
    expect(api.sendPoll).toHaveBeenCalledTimes(2);
    expect(api.sendPoll.mock.calls[0]?.[3]).toMatchObject({ message_thread_id: 99 });
    expect(
      (api.sendPoll.mock.calls[1]?.[3] as { message_thread_id?: unknown } | undefined)
        ?.message_thread_id,
    ).toBeUndefined();
  });

  it("rejects durationHours for Telegram polls", async () => {
    const api = { sendPoll: vi.fn() };

    await expect(
      sendPollTelegram(
        "123",
        { durationHours: 1, options: ["A", "B"], question: "Q" },
        { api: api as unknown as Bot["api"], token: "t" },
      ),
    ).rejects.toThrow(/durationHours is not supported/i);

    expect(api.sendPoll).not.toHaveBeenCalled();
  });

  it("fails when poll send returns no message_id", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ chat: { id: 555 }, poll: { id: "p1" } })),
    };

    await expect(
      sendPollTelegram(
        "123",
        { options: ["A", "B"], question: "Q" },
        { api: api as unknown as Bot["api"], token: "t" },
      ),
    ).rejects.toThrow(/returned no message_id/i);
  });
});

describe("createForumTopicTelegram", () => {
  const cases = [
    {
      expectedCall: ["-1001234567890", "x", undefined] as const,
      expectedResult: {
        chatId: "-1001234567890",
        name: "Build Updates",
        topicId: 272,
      },
      name: "uses base chat id when target includes topic suffix",
      response: { message_thread_id: 272, name: "Build Updates" },
      target: "telegram:group:-1001234567890:topic:271",
      title: "x",
    },
    {
      expectedCall: [
        "-1001234567890",
        "Roadmap",
        { icon_color: 0x6FB9F0, icon_custom_emoji_id: "1234567890" },
      ] as const,
      expectedResult: {
        chatId: "-1001234567890",
        name: "Roadmap",
        topicId: 300,
      },
      name: "forwards optional icon fields",
      options: {
        iconColor: 0x6FB9F0,
        iconCustomEmojiId: "  1234567890  ",
      },
      response: { message_thread_id: 300, name: "Roadmap" },
      target: "-1001234567890",
      title: "Roadmap",
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const createForumTopic = vi.fn().mockResolvedValue(testCase.response);
      const api = { createForumTopic } as unknown as Bot["api"];

      const result = await createForumTopicTelegram(testCase.target, testCase.title, {
        api,
        token: "tok",
        ...("options" in testCase ? testCase.options : {}),
      });

      expect(createForumTopic).toHaveBeenCalledWith(...testCase.expectedCall);
      expect(result).toEqual(testCase.expectedResult);
    });
  }
});
