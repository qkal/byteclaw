import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());
const hasHooksMock = vi.hoisted(() => vi.fn());
const runMessageSendingMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMessageSlackMock(...args),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (...args: unknown[]) => hasHooksMock(...args),
    runMessageSending: (...args: unknown[]) => runMessageSendingMock(...args),
  }),
}));

let slackOutbound: typeof import("./outbound-adapter.js").slackOutbound;
({ slackOutbound } = await import("./outbound-adapter.js"));

describe("slackOutbound", () => {
  const cfg = {
    channels: {
      slack: {
        appToken: "xapp-test",
        botToken: "xoxb-test",
      },
    },
  };

  beforeEach(() => {
    sendMessageSlackMock.mockReset();
    hasHooksMock.mockReset();
    runMessageSendingMock.mockReset();
    hasHooksMock.mockReturnValue(false);
  });

  it("sends payload media first, then finalizes with blocks", async () => {
    sendMessageSlackMock
      .mockResolvedValueOnce({ messageId: "m-media-1" })
      .mockResolvedValueOnce({ messageId: "m-media-2" })
      .mockResolvedValueOnce({ messageId: "m-final" });

    const result = await slackOutbound.sendPayload!({
      accountId: "default",
      cfg,
      mediaLocalRoots: ["/tmp/workspace"],
      payload: {
        channelData: {
          slack: {
            blocks: [
              {
                text: { text: "Block body", type: "plain_text" },
                type: "section",
              },
            ],
          },
        },
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        text: "final text",
      },
      text: "",
      to: "C123",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledTimes(3);
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      1,
      "C123",
      "",
      expect.objectContaining({
        cfg,
        mediaLocalRoots: ["/tmp/workspace"],
        mediaUrl: "https://example.com/1.png",
      }),
    );
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      2,
      "C123",
      "",
      expect.objectContaining({
        cfg,
        mediaLocalRoots: ["/tmp/workspace"],
        mediaUrl: "https://example.com/2.png",
      }),
    );
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      3,
      "C123",
      "final text",
      expect.objectContaining({
        blocks: [
          {
            text: { text: "Block body", type: "plain_text" },
            type: "section",
          },
        ],
        cfg,
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-final" });
  });

  it("cancels sendMedia when message_sending hooks block it", async () => {
    hasHooksMock.mockReturnValue(true);
    runMessageSendingMock.mockResolvedValue({ cancel: true });

    const result = await slackOutbound.sendMedia!({
      accountId: "default",
      cfg,
      mediaUrl: "https://example.com/image.png",
      replyToId: "1712000000.000001",
      text: "caption",
      to: "C123",
    });

    expect(runMessageSendingMock).toHaveBeenCalledWith(
      {
        content: "caption",
        metadata: {
          channelId: "C123",
          mediaUrl: "https://example.com/image.png",
          threadTs: "1712000000.000001",
        },
        to: "C123",
      },
      { accountId: "default", channelId: "slack" },
    );
    expect(sendMessageSlackMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      channel: "slack",
      messageId: "cancelled-by-hook",
      meta: { cancelled: true },
    });
  });
});
