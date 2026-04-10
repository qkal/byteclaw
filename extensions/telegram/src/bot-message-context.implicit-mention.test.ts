import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { TELEGRAM_FORUM_SERVICE_FIELDS } from "./forum-service-message.js";

describe("buildTelegramMessageContext implicitMention forum service messages", () => {
  /**
   * Build a group message context where the user sends a message inside a
   * forum topic that has `reply_to_message` pointing to a message from the
   * bot.  Callers control whether the reply target looks like a forum service
   * message (carries `forum_topic_created` etc.) or a real bot reply.
   */
  async function buildGroupReplyCtx(params: {
    replyToMessageText?: string;
    replyToMessageCaption?: string;
    replyFromIsBot?: boolean;
    replyFromId?: number;
    /** Extra fields on reply_to_message (e.g. forum_topic_created). */
    replyToMessageExtra?: Record<string, unknown>;
  }) {
    const BOT_ID = 7; // Matches test harness primaryCtx.me.id
    return await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -1_001_234_567_890, title: "Forum Group", type: "supergroup" },
        date: 1_700_000_000,
        from: { first_name: "Alice", id: 42 },
        message_id: 100,
        reply_to_message: {
          message_id: 1,
          text: params.replyToMessageText ?? undefined,
          ...(params.replyToMessageCaption != null
            ? { caption: params.replyToMessageCaption }
            : {}),
          from: {
            first_name: "OpenClaw",
            id: params.replyFromId ?? BOT_ID,
            is_bot: params.replyFromIsBot ?? true,
          },
          ...params.replyToMessageExtra,
        },
        text: "hello everyone",
      },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: undefined,
      }),
    });
  }

  it("does NOT trigger implicitMention for forum_topic_created service message", async () => {
    // Bot auto-generated "Topic created" message carries forum_topic_created.
    const ctx = await buildGroupReplyCtx({
      replyFromIsBot: true,
      replyToMessageExtra: {
        forum_topic_created: { icon_color: 0x6f_b9_f0, name: "New Topic" },
      },
      replyToMessageText: undefined,
    });

    // With requireMention and no explicit @mention, the message should be
    // Skipped (null) because implicitMention should NOT fire.
    expect(ctx).toBeNull();
  });

  it.each(TELEGRAM_FORUM_SERVICE_FIELDS)(
    "does NOT trigger implicitMention for %s service message",
    async (field) => {
      const ctx = await buildGroupReplyCtx({
        replyFromIsBot: true,
        replyToMessageExtra: { [field]: {} },
        replyToMessageText: undefined,
      });

      expect(ctx).toBeNull();
    },
  );

  it("does NOT trigger implicitMention for forum_topic_closed service message", async () => {
    const ctx = await buildGroupReplyCtx({
      replyFromIsBot: true,
      replyToMessageExtra: { forum_topic_closed: {} },
      replyToMessageText: undefined,
    });

    expect(ctx).toBeNull();
  });

  it("does NOT trigger implicitMention for general_forum_topic_hidden service message", async () => {
    const ctx = await buildGroupReplyCtx({
      replyFromIsBot: true,
      replyToMessageExtra: { general_forum_topic_hidden: {} },
      replyToMessageText: undefined,
    });

    expect(ctx).toBeNull();
  });

  it("DOES trigger implicitMention for real bot replies (non-empty text)", async () => {
    const ctx = await buildGroupReplyCtx({
      replyFromIsBot: true,
      replyToMessageText: "Here is my answer",
    });

    // Real bot reply → implicitMention fires → message is NOT skipped.
    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });

  it("DOES trigger implicitMention for bot media messages with caption", async () => {
    // Media messages from the bot have caption but no text — they should
    // Still count as real bot replies, not service messages.
    const ctx = await buildGroupReplyCtx({
      replyFromIsBot: true,
      replyToMessageCaption: "Check out this image",
      replyToMessageText: undefined,
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });

  it("DOES trigger implicitMention for bot sticker/voice (no text, no caption, no service field)", async () => {
    // Stickers, voice notes, and captionless photos have neither text nor
    // Caption, but they are NOT service messages — they are legitimate bot
    // Replies that should trigger implicitMention.
    const ctx = await buildGroupReplyCtx({
      replyFromIsBot: true,
      replyToMessageText: undefined,
      // No forum_topic_* fields → not a service message
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });

  it("does NOT trigger implicitMention when reply is from a different user", async () => {
    const ctx = await buildGroupReplyCtx({
      replyFromId: 999,
      replyFromIsBot: false,
      replyToMessageText: "some message",
    });

    // Different user's message → not an implicit mention → skipped.
    expect(ctx).toBeNull();
  });
});
