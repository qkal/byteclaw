import { describe, expect, it, vi } from "vitest";
import {
  buildTelegramRoutingTarget,
  buildTelegramThreadParams,
  buildTypingThreadParams,
  describeReplyTarget,
  expandTextLinks,
  getTelegramTextParts,
  hasBotMention,
  normalizeForwardedContext,
  resolveTelegramDirectPeerId,
  resolveTelegramForumFlag,
  resolveTelegramForumThreadId,
} from "./helpers.js";

describe("resolveTelegramForumThreadId", () => {
  it.each([
    { isForum: false, messageThreadId: 42 },
    { isForum: false, messageThreadId: undefined },
    { isForum: undefined, messageThreadId: 99 },
  ])("returns undefined for non-forum groups", (params) => {
    // Reply threads in regular groups should not create separate sessions.
    expect(resolveTelegramForumThreadId(params)).toBeUndefined();
  });

  it.each([
    { expected: 1, isForum: true, messageThreadId: undefined },
    { expected: 1, isForum: true, messageThreadId: null },
    { expected: 99, isForum: true, messageThreadId: 99 },
  ])("resolves forum topic ids", ({ expected, ...params }) => {
    expect(resolveTelegramForumThreadId(params)).toBe(expected);
  });
});

describe("resolveTelegramForumFlag", () => {
  it("keeps explicit forum metadata when Telegram already provides it", async () => {
    const getChat = vi.fn(async () => ({ is_forum: false }));
    await expect(
      resolveTelegramForumFlag({
        chatId: -100_123,
        chatType: "supergroup",
        getChat,
        isForum: true,
        isGroup: true,
      }),
    ).resolves.toBe(true);
    expect(getChat).not.toHaveBeenCalled();
  });

  it("falls back to getChat for supergroups when is_forum is omitted", async () => {
    const getChat = vi.fn(async () => ({ is_forum: true }));
    await expect(
      resolveTelegramForumFlag({
        chatId: -100_123,
        chatType: "supergroup",
        getChat,
        isGroup: true,
      }),
    ).resolves.toBe(true);
    expect(getChat).toHaveBeenCalledWith(-100_123);
  });

  it("returns false when forum lookup is unavailable", async () => {
    const getChat = vi.fn(async () => {
      throw new Error("lookup failed");
    });
    await expect(
      resolveTelegramForumFlag({
        chatId: -100_123,
        chatType: "supergroup",
        getChat,
        isGroup: true,
      }),
    ).resolves.toBe(false);
  });
});

describe("buildTelegramThreadParams", () => {
  it.each([
    { expected: undefined, input: { id: 1, scope: "forum" as const } },
    { expected: { message_thread_id: 99 }, input: { id: 99, scope: "forum" as const } },
    { expected: { message_thread_id: 1 }, input: { id: 1, scope: "dm" as const } },
    { expected: { message_thread_id: 2 }, input: { id: 2, scope: "dm" as const } },
    { expected: undefined, input: { id: 0, scope: "dm" as const } },
    { expected: undefined, input: { id: -1, scope: "dm" as const } },
    { expected: { message_thread_id: 1 }, input: { id: 1.9, scope: "dm" as const } },
    // Id=0 should be included for forum and none scopes (not falsy)
    { expected: { message_thread_id: 0 }, input: { id: 0, scope: "forum" as const } },
    { expected: { message_thread_id: 0 }, input: { id: 0, scope: "none" as const } },
  ])("builds thread params", ({ input, expected }) => {
    expect(buildTelegramThreadParams(input)).toEqual(expected);
  });
});

describe("buildTelegramRoutingTarget", () => {
  it.each([
    {
      chatId: -100_123,
      expected: "telegram:-100123",
      name: "keeps General forum topic chat-scoped",
      thread: { id: 1, scope: "forum" as const },
    },
    {
      chatId: -100_123,
      expected: "telegram:-100123:topic:42",
      name: "includes real forum topic ids",
      thread: { id: 42, scope: "forum" as const },
    },
    {
      chatId: -100_123,
      expected: "telegram:-100123",
      name: "falls back to bare chat when thread is missing",
      thread: null,
    },
  ])("$name", ({ chatId, thread, expected }) => {
    expect(buildTelegramRoutingTarget(chatId, thread)).toBe(expected);
  });
});

describe("buildTypingThreadParams", () => {
  it.each([
    { expected: undefined, input: undefined },
    { expected: { message_thread_id: 1 }, input: 1 },
  ])("builds typing params", ({ input, expected }) => {
    expect(buildTypingThreadParams(input)).toEqual(expected);
  });
});

describe("resolveTelegramDirectPeerId", () => {
  it("prefers sender id when available", () => {
    expect(resolveTelegramDirectPeerId({ chatId: 777_777_777, senderId: 123_456_789 })).toBe(
      "123456789",
    );
  });

  it("falls back to chat id when sender id is missing", () => {
    expect(resolveTelegramDirectPeerId({ chatId: 777_777_777, senderId: undefined })).toBe(
      "777777777",
    );
  });
});

describe("thread id normalization", () => {
  it.each([
    {
      build: () => buildTelegramThreadParams({ id: 42.9, scope: "forum" }),
      expected: { message_thread_id: 42 },
    },
    {
      build: () => buildTypingThreadParams(42.9),
      expected: { message_thread_id: 42 },
    },
  ])("normalizes thread ids to integers", ({ build, expected }) => {
    expect(build()).toEqual(expected);
  });
});

describe("normalizeForwardedContext", () => {
  it("handles forward_origin users", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        date: 123,
        sender_user: { first_name: "Ada", id: 42, last_name: "Lovelace", username: "ada" },
        type: "user",
      },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Ada Lovelace (@ada)");
    expect(ctx?.fromType).toBe("user");
    expect(ctx?.fromId).toBe("42");
    expect(ctx?.fromUsername).toBe("ada");
    expect(ctx?.fromTitle).toBe("Ada Lovelace");
    expect(ctx?.date).toBe(123);
  });

  it("handles hidden forward_origin names", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: { date: 456, sender_user_name: "Hidden Name", type: "hidden_user" },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Hidden Name");
    expect(ctx?.fromType).toBe("hidden_user");
    expect(ctx?.fromTitle).toBe("Hidden Name");
    expect(ctx?.date).toBe(456);
  });

  it("handles forward_origin channel with author_signature and message_id", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        author_signature: "Editor",
        chat: {
          id: -1_001_234,
          title: "Tech News",
          type: "channel",
          username: "technews",
        },
        date: 500,
        message_id: 42,
        type: "channel",
      },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Tech News (Editor)");
    expect(ctx?.fromType).toBe("channel");
    expect(ctx?.fromId).toBe("-1001234");
    expect(ctx?.fromUsername).toBe("technews");
    expect(ctx?.fromTitle).toBe("Tech News");
    expect(ctx?.fromSignature).toBe("Editor");
    expect(ctx?.fromChatType).toBe("channel");
    expect(ctx?.fromMessageId).toBe(42);
    expect(ctx?.date).toBe(500);
  });

  it("handles forward_origin chat with sender_chat and author_signature", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        author_signature: "Admin",
        date: 600,
        sender_chat: {
          id: -1_005_678,
          title: "Discussion Group",
          type: "supergroup",
        },
        type: "chat",
      },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Discussion Group (Admin)");
    expect(ctx?.fromType).toBe("chat");
    expect(ctx?.fromId).toBe("-1005678");
    expect(ctx?.fromTitle).toBe("Discussion Group");
    expect(ctx?.fromSignature).toBe("Admin");
    expect(ctx?.fromChatType).toBe("supergroup");
    expect(ctx?.date).toBe(600);
  });

  it("uses author_signature from forward_origin", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        author_signature: "New Sig",
        chat: { id: -100_999, title: "My Channel", type: "channel" },
        date: 700,
        message_id: 1,
        type: "channel",
      },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.fromSignature).toBe("New Sig");
    expect(ctx?.from).toBe("My Channel (New Sig)");
  });

  it("returns undefined signature when author_signature is blank", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        author_signature: "   ",
        chat: { id: -100_333, title: "Updates", type: "channel" },
        date: 860,
        message_id: 1,
        type: "channel",
      },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.fromSignature).toBeUndefined();
    expect(ctx?.from).toBe("Updates");
  });

  it("handles forward_origin channel without author_signature", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        chat: { id: -100_111, title: "News", type: "channel" },
        date: 900,
        message_id: 1,
        type: "channel",
      },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("News");
    expect(ctx?.fromSignature).toBeUndefined();
    expect(ctx?.fromChatType).toBe("channel");
  });
});

describe("describeReplyTarget", () => {
  it("returns null when no reply_to_message", () => {
    const result = describeReplyTarget({
      chat: { id: 1, type: "private" },
      date: 1000,
      message_id: 1,
    } as any);
    expect(result).toBeNull();
  });

  it("extracts basic reply info", () => {
    const result = describeReplyTarget({
      chat: { id: 1, type: "private" },
      date: 1000,
      message_id: 2,
      reply_to_message: {
        chat: { id: 1, type: "private" },
        date: 900,
        from: { first_name: "Alice", id: 42, is_bot: false },
        message_id: 1,
        text: "Original message",
      },
    } as any);
    expect(result).not.toBeNull();
    expect(result?.body).toBe("Original message");
    expect(result?.sender).toBe("Alice");
    expect(result?.id).toBe("1");
    expect(result?.kind).toBe("reply");
  });

  it("handles non-string reply text gracefully (issue #27201)", () => {
    const result = describeReplyTarget({
      chat: { id: 1, type: "private" },
      date: 1000,
      message_id: 2,
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private" },
        // Simulate edge case where text is an unexpected non-string value
        text: { some: "object" },
        from: { first_name: "Alice", id: 42, is_bot: false },
      },
    } as any);
    // Should not throw when reply text is malformed; return null instead.
    expect(result).toBeNull();
  });

  it("falls back to caption when reply text is malformed", () => {
    const result = describeReplyTarget({
      chat: { id: 1, type: "private" },
      date: 1000,
      message_id: 2,
      reply_to_message: {
        caption: "Caption body",
        chat: { id: 1, type: "private" },
        date: 900,
        from: { first_name: "Alice", id: 42, is_bot: false },
        message_id: 1,
        text: { some: "object" },
      },
    } as any);
    expect(result?.body).toBe("Caption body");
    expect(result?.kind).toBe("reply");
  });

  it("extracts forwarded context from reply_to_message (issue #9619)", () => {
    // When user forwards a message with a comment, the comment message has
    // Reply_to_message pointing to the forwarded message. We should extract
    // The forward_origin from the reply target.
    const result = describeReplyTarget({
      chat: { id: 1, type: "private" },
      date: 1100,
      message_id: 3,
      reply_to_message: {
        chat: { id: 1, type: "private" },
        date: 1000,
        forward_origin: {
          date: 500,
          sender_user: {
            first_name: "Bob",
            id: 999,
            is_bot: false,
            last_name: "Smith",
            username: "bobsmith",
          },
          type: "user",
        },
        message_id: 2,
        text: "This is the forwarded content",
      },
      text: "Here is my comment about this forwarded content",
    } as any);
    expect(result).not.toBeNull();
    expect(result?.body).toBe("This is the forwarded content");
    expect(result?.id).toBe("2");
    // The reply target's forwarded context should be included
    expect(result?.forwardedFrom).toBeDefined();
    expect(result?.forwardedFrom?.from).toBe("Bob Smith (@bobsmith)");
    expect(result?.forwardedFrom?.fromType).toBe("user");
    expect(result?.forwardedFrom?.fromId).toBe("999");
    expect(result?.forwardedFrom?.date).toBe(500);
  });

  it("extracts forwarded context from channel forward in reply_to_message", () => {
    const result = describeReplyTarget({
      chat: { id: 1, type: "private" },
      date: 1200,
      message_id: 4,
      reply_to_message: {
        chat: { id: 1, type: "private" },
        date: 1100,
        forward_origin: {
          author_signature: "Editor",
          chat: { id: -1_001_234_567, title: "Tech News", type: "channel", username: "technews" },
          date: 800,
          message_id: 456,
          type: "channel",
        },
        message_id: 3,
        text: "Channel post content here",
      },
      text: "Interesting article!",
    } as any);
    expect(result).not.toBeNull();
    expect(result?.forwardedFrom).toBeDefined();
    expect(result?.forwardedFrom?.from).toBe("Tech News (Editor)");
    expect(result?.forwardedFrom?.fromType).toBe("channel");
    expect(result?.forwardedFrom?.fromMessageId).toBe(456);
  });

  it("extracts forwarded context from external_reply", () => {
    const result = describeReplyTarget({
      chat: { id: 1, type: "private" },
      date: 1300,
      external_reply: {
        chat: { id: 1, type: "private" },
        date: 1200,
        forward_origin: {
          date: 700,
          sender_user: {
            first_name: "Eve",
            id: 123,
            is_bot: false,
            last_name: "Stone",
            username: "eve",
          },
          type: "user",
        },
        message_id: 4,
        text: "Forwarded from elsewhere",
      },
      message_id: 5,
      text: "Comment on forwarded message",
    } as any);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("4");
    expect(result?.forwardedFrom?.from).toBe("Eve Stone (@eve)");
    expect(result?.forwardedFrom?.fromType).toBe("user");
    expect(result?.forwardedFrom?.fromId).toBe("123");
    expect(result?.forwardedFrom?.date).toBe(700);
  });
});

describe("hasBotMention", () => {
  it("prefers caption text and caption entities when message text is absent", () => {
    expect(
      getTelegramTextParts({
        caption: "@gaian hello",
        caption_entities: [{ length: 6, offset: 0, type: "mention" }],
        chat: { id: 1, type: "private" },
        date: 1,
        message_id: 1,
      } as any),
    ).toEqual({
      entities: [{ length: 6, offset: 0, type: "mention" }],
      text: "@gaian hello",
    });
  });

  it("matches exact username mentions from plain text", () => {
    expect(
      hasBotMention(
        {
          chat: { id: 1, type: "supergroup" },
          text: "@gaian what is the group id?",
        } as any,
        "gaian",
      ),
    ).toBe(true);
  });

  it("does not match mention prefixes from longer bot usernames", () => {
    expect(
      hasBotMention(
        {
          chat: { id: 1, type: "supergroup" },
          text: "@GaianChat_Bot what is the group id?",
        } as any,
        "gaian",
      ),
    ).toBe(false);
  });

  it("still matches exact mention entities", () => {
    expect(
      hasBotMention(
        {
          chat: { id: 1, type: "supergroup" },
          entities: [{ length: 6, offset: 18, type: "mention" }],
          text: "@GaianChat_Bot hi @gaian",
        } as any,
        "gaian",
      ),
    ).toBe(true);
  });

  it("matches mention followed by punctuation", () => {
    expect(
      hasBotMention(
        {
          chat: { id: 1, type: "supergroup" },
          text: "@gaian, what's up?",
        } as any,
        "gaian",
      ),
    ).toBe(true);
  });

  it("matches mention followed by space", () => {
    expect(
      hasBotMention(
        {
          chat: { id: 1, type: "supergroup" },
          text: "@gaian how are you",
        } as any,
        "gaian",
      ),
    ).toBe(true);
  });

  it("does not match substring of a longer username", () => {
    expect(
      hasBotMention(
        {
          chat: { id: 1, type: "supergroup" },
          text: "@gaianchat_bot hello",
        } as any,
        "gaian",
      ),
    ).toBe(false);
  });

  it("does not match when mention is a prefix of another word", () => {
    expect(
      hasBotMention(
        {
          chat: { id: 1, type: "supergroup" },
          text: "@gaianbot do something",
        } as any,
        "gaian",
      ),
    ).toBe(false);
  });
});
describe("expandTextLinks", () => {
  it("returns text unchanged when no entities are provided", () => {
    expect(expandTextLinks("Hello world")).toBe("Hello world");
    expect(expandTextLinks("Hello world", null)).toBe("Hello world");
    expect(expandTextLinks("Hello world", [])).toBe("Hello world");
  });

  it("returns text unchanged when there are no text_link entities", () => {
    const entities = [
      { length: 5, offset: 0, type: "mention" },
      { length: 5, offset: 6, type: "bold" },
    ];
    expect(expandTextLinks("@user hello", entities)).toBe("@user hello");
  });

  it("expands a single text_link entity", () => {
    const text = "Check this link for details";
    const entities = [{ length: 4, offset: 11, type: "text_link", url: "https://example.com" }];
    expect(expandTextLinks(text, entities)).toBe(
      "Check this [link](https://example.com) for details",
    );
  });

  it("expands multiple text_link entities", () => {
    const text = "Visit Google or GitHub for more";
    const entities = [
      { length: 6, offset: 6, type: "text_link", url: "https://google.com" },
      { length: 6, offset: 16, type: "text_link", url: "https://github.com" },
    ];
    expect(expandTextLinks(text, entities)).toBe(
      "Visit [Google](https://google.com) or [GitHub](https://github.com) for more",
    );
  });

  it("handles adjacent text_link entities", () => {
    const text = "AB";
    const entities = [
      { length: 1, offset: 0, type: "text_link", url: "https://a.example" },
      { length: 1, offset: 1, type: "text_link", url: "https://b.example" },
    ];
    expect(expandTextLinks(text, entities)).toBe("[A](https://a.example)[B](https://b.example)");
  });

  it("preserves offsets from the original string", () => {
    const text = " Hello world";
    const entities = [{ length: 5, offset: 1, type: "text_link", url: "https://example.com" }];
    expect(expandTextLinks(text, entities)).toBe(" [Hello](https://example.com) world");
  });
});
