import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import {
  TELEGRAM_FORUM_SERVICE_FIELDS,
  isTelegramForumServiceMessage,
} from "./forum-service-message.js";

describe("isTelegramForumServiceMessage", () => {
  it("returns true for any Telegram forum service field", () => {
    for (const field of TELEGRAM_FORUM_SERVICE_FIELDS) {
      expect(isTelegramForumServiceMessage({ [field]: {} })).toBe(true);
    }
  });

  it("returns false for normal messages and non-objects", () => {
    expect(isTelegramForumServiceMessage({ text: "hello" })).toBe(false);
    expect(isTelegramForumServiceMessage(null)).toBe(false);
    expect(isTelegramForumServiceMessage("topic created")).toBe(false);
  });
});

describe("buildTelegramMessageContext sender prefix", () => {
  async function buildCtx(params: { messageId: number; options?: Record<string, unknown> }) {
    return await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -99, title: "Dev Chat", type: "supergroup" },
        date: 1_700_000_000,
        from: { first_name: "Alice", id: 42 },
        message_id: params.messageId,
        text: "hello",
      },
      options: params.options,
    });
  }

  it("prefixes group bodies with sender label", async () => {
    const ctx = await buildCtx({ messageId: 1 });

    expect(ctx).not.toBeNull();
    const body = ctx?.ctxPayload?.Body ?? "";
    expect(body).toContain("Alice (42): hello");
  });

  it("sets MessageSid from message_id", async () => {
    const ctx = await buildCtx({ messageId: 12_345 });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageSid).toBe("12345");
  });

  it("respects messageIdOverride option", async () => {
    const ctx = await buildCtx({
      messageId: 12_345,
      options: { messageIdOverride: "67890" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageSid).toBe("67890");
  });
});
