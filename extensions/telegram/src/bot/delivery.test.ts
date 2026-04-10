import type { Bot } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));
const triggerInternalHook = vi.hoisted(() => vi.fn(async () => {}));
const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSending: vi.fn(),
  runMessageSent: vi.fn(),
}));
const baseDeliveryParams = {
  chatId: "123",
  replyToMode: "off",
  textLimit: 4000,
  token: "tok",
} as const;
type DeliverRepliesParams = Parameters<typeof deliverReplies>[0];
type DeliverWithParams = Omit<
  DeliverRepliesParams,
  "chatId" | "token" | "replyToMode" | "textLimit"
> &
  Partial<Pick<DeliverRepliesParams, "replyToMode" | "textLimit" | "mediaLoader">>;
type RuntimeStub = Pick<RuntimeEnv, "error" | "log" | "exit">;

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
}));
vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
}));

vi.mock("../../../../src/plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => messageHookRunner,
}));

vi.mock("../../../../src/hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/hooks/internal-hooks.js")>(
    "../../../../src/hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook,
  };
});

vi.resetModules();
const { deliverReplies } = await import("./delivery.js");

vi.mock("grammy", () => ({
  API_CONSTANTS: {
    ALL_UPDATE_TYPES: ["message"],
    DEFAULT_UPDATE_TYPES: ["message"],
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
}));

function createRuntime(withLog = true): RuntimeStub {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: withLog ? vi.fn() : vi.fn(),
  };
}

function createBot(api: Record<string, unknown> = {}): Bot {
  return { api } as unknown as Bot;
}

async function deliverWith(params: DeliverWithParams) {
  await deliverReplies({
    ...baseDeliveryParams,
    ...params,
    mediaLoader: params.mediaLoader ?? loadWebMedia,
  });
}

function mockMediaLoad(fileName: string, contentType: string, data: string) {
  loadWebMedia.mockResolvedValueOnce({
    buffer: Buffer.from(data),
    contentType,
    fileName,
  });
}

function createSendMessageHarness(messageId = 4) {
  const runtime = createRuntime();
  const sendMessage = vi.fn().mockResolvedValue({
    chat: { id: "123" },
    message_id: messageId,
  });
  const bot = createBot({ sendMessage });
  return { bot, runtime, sendMessage };
}

function createVoiceMessagesForbiddenError() {
  return new Error(
    "GrammyError: Call to 'sendVoice' failed! (400: Bad Request: VOICE_MESSAGES_FORBIDDEN)",
  );
}

function createThreadNotFoundError(operation = "sendMessage") {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: message thread not found)`,
  );
}

function createVoiceFailureHarness(params: {
  voiceError: Error;
  sendMessageResult?: { message_id: number; chat: { id: string } };
}) {
  const runtime = createRuntime();
  const sendVoice = vi.fn().mockRejectedValue(params.voiceError);
  const sendMessage = params.sendMessageResult
    ? vi.fn().mockResolvedValue(params.sendMessageResult)
    : vi.fn();
  const bot = createBot({ sendMessage, sendVoice });
  return { bot, runtime, sendMessage, sendVoice };
}

describe("deliverReplies", () => {
  beforeEach(() => {
    loadWebMedia.mockClear();
    triggerInternalHook.mockReset();
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSending.mockReset();
    messageHookRunner.runMessageSent.mockReset();
  });

  it("skips audioAsVoice-only payloads without logging an error", async () => {
    const runtime = createRuntime(false);

    await deliverWith({
      bot: createBot(),
      replies: [{ audioAsVoice: true }],
      runtime,
    });

    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("skips malformed replies and continues with valid entries", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ chat: { id: "123" }, message_id: 1 });
    const bot = createBot({ sendMessage });

    await deliverWith({
      bot,
      replies: [undefined, { text: "hello" }] as unknown as DeliverRepliesParams["replies"],
      runtime,
    });

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toBe("hello");
  });

  it("reports message_sent success=false when hooks blank out a text-only reply", async () => {
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sending" || name === "message_sent",
    );
    messageHookRunner.runMessageSending.mockResolvedValue({ content: "   " });

    const runtime = createRuntime(false);
    const sendMessage = vi.fn();
    const bot = createBot({ sendMessage });

    await deliverWith({
      bot,
      replies: [{ text: "hello" }],
      runtime,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ content: "   ", success: false }),
      expect.objectContaining({ channelId: "telegram", conversationId: "123" }),
    );
  });

  it("passes accountId into message hooks", async () => {
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sending" || name === "message_sent",
    );

    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ chat: { id: "123" }, message_id: 9 });
    const bot = createBot({ sendMessage });

    await deliverWith({
      accountId: "work",
      bot,
      replies: [{ text: "hello" }],
      runtime,
    });

    expect(messageHookRunner.runMessageSending).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        accountId: "work",
        channelId: "telegram",
        conversationId: "123",
      }),
    );
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
      expect.objectContaining({
        accountId: "work",
        channelId: "telegram",
        conversationId: "123",
      }),
    );
  });

  it("sets disable_notification when silent is true", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "123" },
      message_id: 5,
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      bot,
      replies: [{ text: "hello" }],
      runtime,
      silent: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        disable_notification: true,
      }),
    );
  });

  it("emits internal message:sent when session hook context is available", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ chat: { id: "123" }, message_id: 9 });
    const bot = createBot({ sendMessage });

    await deliverWith({
      bot,
      mirrorGroupId: "123",
      mirrorIsGroup: true,
      replies: [{ text: "hello" }],
      runtime,
      sessionKeyForInternalHooks: "agent:test:telegram:123",
    });

    expect(triggerInternalHook).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sent",
        context: expect.objectContaining({
          channelId: "telegram",
          content: "hello",
          conversationId: "123",
          groupId: "123",
          isGroup: true,
          messageId: "9",
          success: true,
          to: "123",
        }),
        sessionKey: "agent:test:telegram:123",
        type: "message",
      }),
    );
  });

  it("does not emit internal message:sent without a session key", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ chat: { id: "123" }, message_id: 11 });
    const bot = createBot({ sendMessage });

    await deliverWith({
      bot,
      replies: [{ text: "hello" }],
      runtime,
    });

    expect(triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits internal message:sent with success=false on delivery failure", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockRejectedValue(new Error("network error"));
    const bot = createBot({ sendMessage });

    await expect(
      deliverWith({
        bot,
        replies: [{ text: "hello" }],
        runtime,
        sessionKeyForInternalHooks: "agent:test:telegram:123",
      }),
    ).rejects.toThrow("network error");

    expect(triggerInternalHook).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sent",
        context: expect.objectContaining({
          channelId: "telegram",
          content: "hello",
          conversationId: "123",
          error: "network error",
          success: false,
          to: "123",
        }),
        sessionKey: "agent:test:telegram:123",
        type: "message",
      }),
    );
  });

  it("passes media metadata to message_sending hooks", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sending");

    const runtime = createRuntime(false);
    const sendPhoto = vi.fn().mockResolvedValue({ chat: { id: "123" }, message_id: 2 });
    const bot = createBot({ sendPhoto });

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      bot,
      replies: [{ mediaUrl: "https://example.com/photo.jpg", text: "caption" }],
      runtime,
    });

    expect(messageHookRunner.runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "caption",
        metadata: expect.objectContaining({
          channel: "telegram",
          mediaUrls: ["https://example.com/photo.jpg"],
        }),
        to: "123",
      }),
      expect.objectContaining({ channelId: "telegram", conversationId: "123" }),
    );
  });

  it("invokes onVoiceRecording before sending a voice note", async () => {
    const events: string[] = [];
    const runtime = createRuntime(false);
    const sendVoice = vi.fn(async () => {
      events.push("sendVoice");
      return { chat: { id: "123" }, message_id: 1 };
    });
    const bot = createBot({ sendVoice });
    const onVoiceRecording = vi.fn(async () => {
      events.push("recordVoice");
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      bot,
      onVoiceRecording,
      replies: [{ audioAsVoice: true, mediaUrl: "https://example.com/note.ogg" }],
      runtime,
    });

    expect(onVoiceRecording).toHaveBeenCalledTimes(1);
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["recordVoice", "sendVoice"]);
  });

  it("renders markdown in media captions", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: "123" },
      message_id: 2,
    });
    const bot = createBot({ sendPhoto });

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      bot,
      replies: [{ mediaUrl: "https://example.com/photo.jpg", text: "hi **boss**" }],
      runtime,
    });

    expect(sendPhoto).toHaveBeenCalledWith(
      "123",
      expect.anything(),
      expect.objectContaining({
        caption: "hi <b>boss</b>",
        parse_mode: "HTML",
      }),
    );
  });

  it("passes mediaLocalRoots to media loading", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: "123" },
      message_id: 12,
    });
    const bot = createBot({ sendPhoto });
    const mediaLocalRoots = ["/tmp/workspace-work"];

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      bot,
      mediaLocalRoots,
      replies: [{ mediaUrl: "/tmp/workspace-work/photo.jpg" }],
      runtime,
    });

    expect(loadWebMedia).toHaveBeenCalledWith("/tmp/workspace-work/photo.jpg", {
      localRoots: mediaLocalRoots,
    });
  });

  it("includes link_preview_options when linkPreview is false", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "123" },
      message_id: 3,
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      bot,
      linkPreview: false,
      replies: [{ text: "Check https://example.com" }],
      runtime,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        link_preview_options: { is_disabled: true },
      }),
    );
  });

  it("includes message_thread_id for DM topics", async () => {
    const { runtime, sendMessage, bot } = createSendMessageHarness();

    await deliverWith({
      bot,
      replies: [{ text: "Hello" }],
      runtime,
      thread: { id: 42, scope: "dm" },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        message_thread_id: 42,
      }),
    );
  });

  it("retries DM topic sends without message_thread_id when thread is missing", async () => {
    const runtime = createRuntime();
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(createThreadNotFoundError("sendMessage"))
      .mockResolvedValueOnce({
        chat: { id: "123" },
        message_id: 7,
      });
    const bot = createBot({ sendMessage });

    await deliverWith({
      bot,
      replies: [{ text: "hello" }],
      runtime,
      thread: { id: 42, scope: "dm" },
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        message_thread_id: 42,
      }),
    );
    expect(sendMessage.mock.calls[1]?.[2]).not.toHaveProperty("message_thread_id");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("does not retry forum sends without message_thread_id", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockRejectedValue(createThreadNotFoundError("sendMessage"));
    const bot = createBot({ sendMessage });

    await expect(
      deliverWith({
        bot,
        replies: [{ text: "hello" }],
        runtime,
        thread: { id: 42, scope: "forum" },
      }),
    ).rejects.toThrow("message thread not found");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledTimes(1);
  });

  it("retries media sends without message_thread_id for DM topics", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi
      .fn()
      .mockRejectedValueOnce(createThreadNotFoundError("sendPhoto"))
      .mockResolvedValueOnce({
        chat: { id: "123" },
        message_id: 8,
      });
    const bot = createBot({ sendPhoto });

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      bot,
      replies: [{ mediaUrl: "https://example.com/photo.jpg", text: "caption" }],
      runtime,
      thread: { id: 42, scope: "dm" },
    });

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expect(sendPhoto.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        message_thread_id: 42,
      }),
    );
    expect(sendPhoto.mock.calls[1]?.[2]).not.toHaveProperty("message_thread_id");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("does not include link_preview_options when linkPreview is true", async () => {
    const { runtime, sendMessage, bot } = createSendMessageHarness();

    await deliverWith({
      bot,
      linkPreview: true,
      replies: [{ text: "Check https://example.com" }],
      runtime,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.not.objectContaining({
        link_preview_options: expect.anything(),
      }),
    );
  });

  it("falls back to plain text when markdown renders to empty HTML in threaded mode", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn(async (_chatId: string, text: string) => {
      if (text === "") {
        throw new Error("400: Bad Request: message text is empty");
      }
      return {
        chat: { id: "123" },
        message_id: 6,
      };
    });
    const bot = { api: { sendMessage } } as unknown as Bot;

    await deliverReplies({
      bot,
      chatId: "123",
      replies: [{ text: ">" }],
      replyToMode: "off",
      runtime,
      textLimit: 4000,
      thread: { id: 42, scope: "forum" },
      token: "tok",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      ">",
      expect.objectContaining({
        message_thread_id: 42,
      }),
    );
  });

  it("skips whitespace-only text replies without calling Telegram", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn();
    const bot = { api: { sendMessage } } as unknown as Bot;

    await expect(
      deliverReplies({
        bot,
        chatId: "123",
        replies: [{ text: "   " }],
        replyToMode: "off",
        runtime,
        textLimit: 4000,
        token: "tok",
      }),
    ).resolves.toEqual({ delivered: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses reply_to_message_id when quote text is provided", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "123" },
      message_id: 10,
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      bot,
      replies: [{ replyToId: "500", text: "Hello there" }],
      replyQuoteText: "quoted text",
      replyToMode: "all",
      runtime,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        allow_sending_without_reply: true,
        reply_to_message_id: 500,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.not.objectContaining({
        reply_parameters: expect.anything(),
      }),
    );
  });

  it("falls back to text when sendVoice fails with VOICE_MESSAGES_FORBIDDEN", async () => {
    const { runtime, sendVoice, sendMessage, bot } = createVoiceFailureHarness({
      sendMessageResult: {
        chat: { id: "123" },
        message_id: 5,
      },
      voiceError: createVoiceMessagesForbiddenError(),
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      bot,
      replies: [
        { audioAsVoice: true, mediaUrl: "https://example.com/note.ogg", text: "Hello there" },
      ],
      runtime,
    });

    // Voice was attempted but failed
    expect(sendVoice).toHaveBeenCalledTimes(1);
    // Fallback to text succeeded
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Hello there"),
      expect.any(Object),
    );
  });

  it("keeps disable_notification on voice fallback text when silent is true", async () => {
    const runtime = createRuntime();
    const sendVoice = vi.fn().mockRejectedValue(createVoiceMessagesForbiddenError());
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "123" },
      message_id: 5,
    });
    const bot = createBot({ sendMessage, sendVoice });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      bot,
      replies: [
        { audioAsVoice: true, mediaUrl: "https://example.com/note.ogg", text: "Hello there" },
      ],
      runtime,
      silent: true,
    });

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Hello there"),
      expect.objectContaining({
        disable_notification: true,
      }),
    );
  });

  it("voice fallback applies reply-to only on first chunk when replyToMode is first", async () => {
    const { runtime, sendVoice, sendMessage, bot } = createVoiceFailureHarness({
      sendMessageResult: {
        chat: { id: "123" },
        message_id: 6,
      },
      voiceError: createVoiceMessagesForbiddenError(),
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      bot,
      replies: [
        {
          audioAsVoice: true,
          channelData: {
            telegram: {
              buttons: [[{ text: "Ack", callback_data: "ack" }]],
            },
          },
          mediaUrl: "https://example.com/note.ogg",
          replyToId: "77",
          text: "chunk-one\n\nchunk-two",
        },
      ],
      replyQuoteText: "quoted context",
      replyToMode: "first",
      runtime,
      textLimit: 12,
    });

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sendMessage.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        allow_sending_without_reply: true,
        reply_markup: {
          inline_keyboard: [[{ callback_data: "ack", text: "Ack" }]],
        },
        reply_to_message_id: 77,
      }),
    );
    expect(sendMessage.mock.calls[1][2]).not.toEqual(
      expect.objectContaining({ reply_to_message_id: 77 }),
    );
    expect(sendMessage.mock.calls[1][2]).not.toHaveProperty("reply_parameters");
    expect(sendMessage.mock.calls[1][2]).not.toHaveProperty("reply_markup");
  });

  it("rethrows non-VOICE_MESSAGES_FORBIDDEN errors from sendVoice", async () => {
    const runtime = createRuntime();
    const sendVoice = vi.fn().mockRejectedValue(new Error("Network error"));
    const sendMessage = vi.fn();
    const bot = createBot({ sendMessage, sendVoice });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await expect(
      deliverWith({
        bot,
        replies: [{ audioAsVoice: true, mediaUrl: "https://example.com/note.ogg", text: "Hello" }],
        runtime,
      }),
    ).rejects.toThrow("Network error");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    // Text fallback should NOT be attempted for other errors
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("replyToMode 'first' only applies reply-to to the first text chunk", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "123" },
      message_id: 20,
    });
    const bot = createBot({ sendMessage });

    // Use a small textLimit to force multiple chunks
    await deliverReplies({
      bot,
      chatId: "123",
      replies: [{ replyToId: "700", text: "chunk-one\n\nchunk-two" }],
      replyToMode: "first",
      runtime,
      textLimit: 12,
      token: "tok",
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    // First chunk should have reply_to_message_id
    expect(sendMessage.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        allow_sending_without_reply: true,
        reply_to_message_id: 700,
      }),
    );
    // Second chunk should NOT have reply_to_message_id
    expect(sendMessage.mock.calls[1][2]).not.toHaveProperty("reply_to_message_id");
  });

  it("replyToMode 'all' applies reply-to to every text chunk", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "123" },
      message_id: 21,
    });
    const bot = createBot({ sendMessage });

    await deliverReplies({
      bot,
      chatId: "123",
      replies: [{ replyToId: "800", text: "chunk-one\n\nchunk-two" }],
      replyToMode: "all",
      runtime,
      textLimit: 12,
      token: "tok",
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Both chunks should have reply_to_message_id
    for (const call of sendMessage.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          allow_sending_without_reply: true,
          reply_to_message_id: 800,
        }),
      );
    }
  });

  it("replyToMode 'first' only applies reply-to to first media item", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: "123" },
      message_id: 30,
    });
    const bot = createBot({ sendPhoto });

    mockMediaLoad("a.jpg", "image/jpeg", "img1");
    mockMediaLoad("b.jpg", "image/jpeg", "img2");

    await deliverReplies({
      bot,
      chatId: "123",
      replies: [{ mediaUrls: ["https://a.jpg", "https://b.jpg"], replyToId: "900" }],
      replyToMode: "first",
      runtime,
      textLimit: 4000,
      token: "tok",
    });

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    // First media should have reply_to_message_id
    expect(sendPhoto.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        allow_sending_without_reply: true,
        reply_to_message_id: 900,
      }),
    );
    // Second media should NOT have reply_to_message_id
    expect(sendPhoto.mock.calls[1][2]).not.toHaveProperty("reply_to_message_id");
  });

  it("pins the first delivered text message when telegram pin is requested", async () => {
    const runtime = createRuntime();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ chat: { id: "123" }, message_id: 101 })
      .mockResolvedValueOnce({ chat: { id: "123" }, message_id: 102 });
    const pinChatMessage = vi.fn().mockResolvedValue(true);
    const bot = createBot({ pinChatMessage, sendMessage });

    await deliverReplies({
      bot,
      chatId: "123",
      replies: [{ channelData: { telegram: { pin: true } }, text: "chunk-one\n\nchunk-two" }],
      replyToMode: "off",
      runtime,
      textLimit: 12,
      token: "tok",
    });

    expect(pinChatMessage).toHaveBeenCalledTimes(1);
    expect(pinChatMessage).toHaveBeenCalledWith("123", 101, { disable_notification: true });
  });

  it("continues when pinning fails", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ chat: { id: "123" }, message_id: 201 });
    const pinChatMessage = vi.fn().mockRejectedValue(new Error("pin failed"));
    const bot = createBot({ pinChatMessage, sendMessage });

    await deliverWith({
      bot,
      replies: [{ channelData: { telegram: { pin: true } }, text: "hello" }],
      runtime,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(pinChatMessage).toHaveBeenCalledTimes(1);
  });

  it("rethrows VOICE_MESSAGES_FORBIDDEN when no text fallback is available", async () => {
    const { runtime, sendVoice, sendMessage, bot } = createVoiceFailureHarness({
      voiceError: createVoiceMessagesForbiddenError(),
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await expect(
      deliverWith({
        bot,
        replies: [{ audioAsVoice: true, mediaUrl: "https://example.com/note.ogg" }],
        runtime,
      }),
    ).rejects.toThrow("VOICE_MESSAGES_FORBIDDEN");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
