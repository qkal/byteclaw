import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageTelegramMock = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

import { telegramOutbound } from "./outbound-adapter.js";

describe("telegramOutbound", () => {
  beforeEach(() => {
    sendMessageTelegramMock.mockReset();
  });

  it("forwards mediaLocalRoots in direct media sends", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-media" });

    const result = await telegramOutbound.sendMedia!({
      accountId: "ops",
      cfg: {} as never,
      deps: { sendTelegram: sendMessageTelegramMock },
      mediaLocalRoots: ["/tmp/agent-root"],
      mediaUrl: "/tmp/image.png",
      replyToId: "900",
      text: "hello",
      threadId: "12",
      to: "12345",
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "hello",
      expect.objectContaining({
        accountId: "ops",
        mediaLocalRoots: ["/tmp/agent-root"],
        mediaUrl: "/tmp/image.png",
        messageThreadId: 12,
        replyToMessageId: 900,
        textMode: "html",
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-media" });
  });

  it("sends payload media in sequence and keeps buttons on the first message only", async () => {
    sendMessageTelegramMock
      .mockResolvedValueOnce({ chatId: "12345", messageId: "tg-1" })
      .mockResolvedValueOnce({ chatId: "12345", messageId: "tg-2" });

    const result = await telegramOutbound.sendPayload!({
      accountId: "ops",
      cfg: {} as never,
      deps: { sendTelegram: sendMessageTelegramMock },
      mediaLocalRoots: ["/tmp/media"],
      payload: {
        channelData: {
          telegram: {
            buttons: [[{ callback_data: "/approve abc allow-once", text: "Allow Once" }]],
            quoteText: "quoted",
          },
        },
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
        text: "Approval required",
      },
      text: "",
      to: "12345",
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledTimes(2);
    expect(sendMessageTelegramMock).toHaveBeenNthCalledWith(
      1,
      "12345",
      "Approval required",
      expect.objectContaining({
        buttons: [[{ callback_data: "/approve abc allow-once", text: "Allow Once" }]],
        mediaLocalRoots: ["/tmp/media"],
        mediaUrl: "https://example.com/1.jpg",
        quoteText: "quoted",
      }),
    );
    expect(sendMessageTelegramMock).toHaveBeenNthCalledWith(
      2,
      "12345",
      "",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/media"],
        mediaUrl: "https://example.com/2.jpg",
        quoteText: "quoted",
      }),
    );
    expect(
      (sendMessageTelegramMock.mock.calls[1]?.[2] as Record<string, unknown>)?.buttons,
    ).toBeUndefined();
    expect(result).toEqual({ channel: "telegram", chatId: "12345", messageId: "tg-2" });
  });
});
