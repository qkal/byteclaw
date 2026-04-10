import { describe, expect, it, vi } from "vitest";
import type { LineAutoReplyDeps } from "./auto-reply-delivery.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { sendLineReplyChunks } from "./reply-chunks.js";

const createFlexMessage = (altText: string, contents: unknown) => ({
  altText,
  contents,
  type: "flex" as const,
});

const createImageMessage = (url: string) => ({
  originalContentUrl: url,
  previewImageUrl: url,
  type: "image" as const,
});

const createLocationMessage = (location: {
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}) => ({
  type: "location" as const,
  ...location,
});

describe("deliverLineAutoReply", () => {
  const baseDeliveryParams = {
    accountId: "acc",
    replyToken: "token",
    replyTokenUsed: false,
    textLimit: 5000,
    to: "line:user:1",
  };

  function createDeps(overrides?: Partial<LineAutoReplyDeps>) {
    const replyMessageLine = vi.fn(async () => ({}));
    const pushMessageLine = vi.fn(async () => ({}));
    const pushTextMessageWithQuickReplies = vi.fn(async () => ({}));
    const createTextMessageWithQuickReplies = vi.fn((text: string) => ({
      text,
      type: "text" as const,
    }));
    const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
    const pushMessagesLine = vi.fn(async () => ({ chatId: "u1", messageId: "push" }));

    const deps: LineAutoReplyDeps = {
      buildTemplateMessageFromPayload: () => null,
      chunkMarkdownText: (text) => [text],
      createFlexMessage: createFlexMessage as LineAutoReplyDeps["createFlexMessage"],
      createImageMessage,
      createLocationMessage,
      createQuickReplyItems: createQuickReplyItems as LineAutoReplyDeps["createQuickReplyItems"],
      createTextMessageWithQuickReplies,
      processLineMessage: (text) => ({ flexMessages: [], text }),
      pushMessageLine,
      pushMessagesLine,
      pushTextMessageWithQuickReplies,
      replyMessageLine,
      sendLineReplyChunks,
      ...overrides,
    };

    return {
      createQuickReplyItems,
      createTextMessageWithQuickReplies,
      deps,
      pushMessageLine,
      pushMessagesLine,
      pushTextMessageWithQuickReplies,
      replyMessageLine,
    };
  }

  it("uses reply token for text before sending rich messages", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const { deps, replyMessageLine, pushMessagesLine, createQuickReplyItems } = createDeps();

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      deps,
      lineData,
      payload: { channelData: { line: lineData }, text: "hello" },
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(replyMessageLine).toHaveBeenCalledWith("token", [{ text: "hello", type: "text" }], {
      accountId: "acc",
    });
    expect(pushMessagesLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [createFlexMessage("Card", { type: "bubble" })],
      { accountId: "acc" },
    );
    expect(createQuickReplyItems).not.toHaveBeenCalled();
  });

  it("uses reply token for rich-only payloads", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const { deps, replyMessageLine, pushMessagesLine, createQuickReplyItems } = createDeps({
      chunkMarkdownText: () => [],
      processLineMessage: () => ({ flexMessages: [], text: "" }),
      sendLineReplyChunks: vi.fn(async () => ({ replyTokenUsed: false })),
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      deps,
      lineData,
      payload: { channelData: { line: lineData } },
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        {
          ...createFlexMessage("Card", { type: "bubble" }),
          quickReply: { items: ["A"] },
        },
      ],
      { accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(createQuickReplyItems).toHaveBeenCalledWith(["A"]);
  });

  it("sends rich messages before quick-reply text so quick replies remain visible", async () => {
    const createTextMessageWithQuickReplies = vi.fn((text: string, _quickReplies: string[]) => ({
      quickReply: { items: ["A"] },
      text,
      type: "text" as const,
    }));

    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const { deps, pushMessagesLine, replyMessageLine } = createDeps({
      createTextMessageWithQuickReplies:
        createTextMessageWithQuickReplies as LineAutoReplyDeps["createTextMessageWithQuickReplies"],
    });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      deps,
      lineData,
      payload: { channelData: { line: lineData }, text: "hello" },
    });

    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [createFlexMessage("Card", { type: "bubble" })],
      { accountId: "acc" },
    );
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        {
          quickReply: { items: ["A"] },
          text: "hello",
          type: "text",
        },
      ],
      { accountId: "acc" },
    );
    const pushOrder = pushMessagesLine.mock.invocationCallOrder[0];
    const replyOrder = replyMessageLine.mock.invocationCallOrder[0];
    expect(pushOrder).toBeLessThan(replyOrder);
  });

  it("falls back to push when reply token delivery fails", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const failingReplyMessageLine = vi.fn(async () => {
      throw new Error("reply failed");
    });
    const { deps, pushMessagesLine } = createDeps({
      chunkMarkdownText: () => [],
      processLineMessage: () => ({ flexMessages: [], text: "" }),
      replyMessageLine: failingReplyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      deps,
      lineData,
      payload: { channelData: { line: lineData } },
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(failingReplyMessageLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [createFlexMessage("Card", { type: "bubble" })],
      { accountId: "acc" },
    );
  });
});
