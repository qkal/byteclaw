import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

let deliverReplies: typeof import("./replies.js").deliverReplies;
let resolveSlackThreadTs: typeof import("./replies.js").resolveSlackThreadTs;
import { deliverSlackSlashReplies } from "./replies.js";

function baseParams(overrides?: Record<string, unknown>) {
  return {
    replies: [{ text: "hello" }],
    replyToMode: "off" as const,
    runtime: { error: () => {}, exit: () => {}, log: () => {} },
    target: "C123",
    textLimit: 4000,
    token: "xoxb-test",
    ...overrides,
  };
}

describe("deliverReplies identity passthrough", () => {
  beforeAll(async () => {
    ({ deliverReplies, resolveSlackThreadTs } = await import("./replies.js"));
  });

  beforeEach(() => {
    sendMock.mockReset();
  });
  it("passes identity to sendMessageSlack for text replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { iconEmoji: ":robot:", username: "Bot" };
    await deliverReplies(baseParams({ identity }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("passes identity to sendMessageSlack for media replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { iconUrl: "https://example.com/icon.png", username: "Bot" };
    await deliverReplies(
      baseParams({
        identity,
        replies: [{ mediaUrls: ["https://example.com/img.png"], text: "caption" }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("omits identity key when not provided", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverReplies(baseParams());

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty("identity");
  });

  it("delivers block-only replies through to sendMessageSlack", async () => {
    sendMock.mockResolvedValue(undefined);
    const blocks = [
      {
        elements: [
          {
            action_id: "openclaw:reply_button",
            text: { text: "Option A", type: "plain_text" },
            type: "button",
            value: "reply_1_option_a",
          },
        ],
        type: "actions",
      },
    ];

    await deliverReplies(
      baseParams({
        replies: [
          {
            channelData: {
              slack: {
                blocks,
              },
            },
            text: "",
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledWith(
      "C123",
      "",
      expect.objectContaining({
        blocks,
      }),
    );
  });

  it("renders interactive replies into Slack blocks during delivery", async () => {
    sendMock.mockResolvedValue(undefined);

    await deliverReplies(
      baseParams({
        replies: [
          {
            interactive: {
              blocks: [
                { text: "Choose", type: "text" },
                {
                  buttons: [{ label: "Approve", value: "approve", style: "primary" }],
                  type: "buttons",
                },
              ],
            },
            text: "Choose",
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      blocks: [
        expect.objectContaining({ type: "section" }),
        expect.objectContaining({
          elements: [
            expect.objectContaining({
              action_id: "openclaw:reply_button:1:1",
              style: "primary",
              value: "approve",
            }),
          ],
          type: "actions",
        }),
      ],
    });
  });

  it("rejects replies when merged Slack blocks exceed the platform limit", async () => {
    sendMock.mockResolvedValue(undefined);

    await expect(
      deliverReplies(
        baseParams({
          replies: [
            {
              channelData: {
                slack: {
                  blocks: Array.from({ length: 50 }, () => ({ type: "divider" })),
                },
              },
              interactive: {
                blocks: [{ buttons: [{ label: "Retry", value: "retry" }], type: "buttons" }],
              },
              text: "Choose",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/Slack blocks cannot exceed 50 items/i);
  });
});

describe("resolveSlackThreadTs fallback classification", () => {
  const threadTs = "1234567890.123456";
  const messageTs = "9999999999.999999";

  it("keeps legacy thread-stickiness for genuine replies when callers omit isThreadReply", () => {
    expect(
      resolveSlackThreadTs({
        hasReplied: false,
        incomingThreadTs: threadTs,
        messageTs,
        replyToMode: "off",
      }),
    ).toBe(threadTs);
  });

  it("respects replyToMode for auto-created top-level thread_ts when callers omit isThreadReply", () => {
    expect(
      resolveSlackThreadTs({
        hasReplied: false,
        incomingThreadTs: messageTs,
        messageTs,
        replyToMode: "off",
      }),
    ).toBeUndefined();

    expect(
      resolveSlackThreadTs({
        hasReplied: false,
        incomingThreadTs: messageTs,
        messageTs,
        replyToMode: "first",
      }),
    ).toBe(messageTs);

    expect(
      resolveSlackThreadTs({
        hasReplied: true,
        incomingThreadTs: messageTs,
        messageTs,
        replyToMode: "batched",
      }),
    ).toBeUndefined();
  });
});

describe("deliverSlackSlashReplies chunking", () => {
  it("keeps a 4205-character reply in a single slash response by default", async () => {
    const respond = vi.fn(async () => undefined);
    const text = "a".repeat(4205);

    await deliverSlackSlashReplies({
      ephemeral: true,
      replies: [{ text }],
      respond,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text,
    });
  });
});
