import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageIMessageMock = vi.hoisted(() =>
  vi.fn().mockImplementation(async (_to: string, message: string) => ({
    messageId: "imsg-1",
    sentText: message,
  })),
);
const chunkTextWithModeMock = vi.hoisted(() => vi.fn((text: string) => [text]));
const resolveChunkModeMock = vi.hoisted(() => vi.fn(() => "length"));
const convertMarkdownTablesMock = vi.hoisted(() => vi.fn((text: string) => text));
const resolveMarkdownTableModeMock = vi.hoisted(() => vi.fn(() => "code"));

vi.mock("../send.js", () => ({
  sendMessageIMessage: (to: string, message: string, opts?: unknown) =>
    sendMessageIMessageMock(to, message, opts),
}));

vi.mock("./deliver.runtime.js", () => ({
  chunkTextWithMode: (text: string) => chunkTextWithModeMock(text),
  convertMarkdownTables: (text: string) => convertMarkdownTablesMock(text),
  loadConfig: vi.fn(() => ({})),
  resolveChunkMode: vi.fn(() => resolveChunkModeMock()),
  resolveMarkdownTableMode: vi.fn(() => resolveMarkdownTableModeMock()),
}));

let deliverReplies: typeof import("./deliver.js").deliverReplies;

describe("deliverReplies", () => {
  const runtime = { error: vi.fn(), log: vi.fn() } as unknown as RuntimeEnv;
  const client = {} as Awaited<ReturnType<typeof import("../client.js").createIMessageRpcClient>>;

  beforeAll(async () => {
    ({ deliverReplies } = await import("./deliver.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    chunkTextWithModeMock.mockImplementation((text: string) => [text]);
  });

  it("propagates payload replyToId through all text chunks", async () => {
    chunkTextWithModeMock.mockImplementation((text: string) => text.split("|"));

    await deliverReplies({
      accountId: "default",
      client,
      maxBytes: 4096,
      replies: [{ replyToId: "reply-1", text: "first|second" }],
      runtime,
      target: "chat_id:10",
      textLimit: 4000,
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      1,
      "chat_id:10",
      "first",
      expect.objectContaining({
        accountId: "default",
        client,
        maxBytes: 4096,
        replyToId: "reply-1",
      }),
    );
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      2,
      "chat_id:10",
      "second",
      expect.objectContaining({
        accountId: "default",
        client,
        maxBytes: 4096,
        replyToId: "reply-1",
      }),
    );
  });

  it("propagates payload replyToId through media sends", async () => {
    await deliverReplies({
      accountId: "acct-2",
      client,
      maxBytes: 8192,
      replies: [
        {
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          replyToId: "reply-2",
          text: "caption",
        },
      ],
      runtime,
      target: "chat_id:20",
      textLimit: 4000,
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      1,
      "chat_id:20",
      "caption",
      expect.objectContaining({
        accountId: "acct-2",
        client,
        maxBytes: 8192,
        mediaUrl: "https://example.com/a.jpg",
        replyToId: "reply-2",
      }),
    );
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      2,
      "chat_id:20",
      "",
      expect.objectContaining({
        accountId: "acct-2",
        client,
        maxBytes: 8192,
        mediaUrl: "https://example.com/b.jpg",
        replyToId: "reply-2",
      }),
    );
  });

  it("records outbound text and message ids in sent-message cache (post-send only)", async () => {
    // Fix for #47830: remember() is called ONLY after each chunk is sent,
    // Never with the full un-chunked text before sending begins.
    // Pre-send population widened the false-positive window in self-chat.
    const remember = vi.fn();
    chunkTextWithModeMock.mockImplementation((text: string) => text.split("|"));
    sendMessageIMessageMock
      .mockResolvedValueOnce({ messageId: "imsg-1", sentText: "first" })
      .mockResolvedValueOnce({ messageId: "imsg-2", sentText: "second" });

    await deliverReplies({
      accountId: "acct-3",
      client,
      maxBytes: 2048,
      replies: [{ text: "first|second" }],
      runtime,
      sentMessageCache: { remember },
      target: "chat_id:30",
      textLimit: 4000,
    });

    // Only the two per-chunk post-send calls — no pre-send full-text call.
    expect(remember).toHaveBeenCalledTimes(2);
    expect(remember).toHaveBeenCalledWith("acct-3:chat_id:30", {
      messageId: "imsg-1",
      text: "first",
    });
    expect(remember).toHaveBeenCalledWith("acct-3:chat_id:30", {
      messageId: "imsg-2",
      text: "second",
    });
  });

  it("records the actual sent placeholder for media-only replies", async () => {
    const remember = vi.fn();
    sendMessageIMessageMock.mockResolvedValueOnce({
      messageId: "imsg-media-1",
      sentText: "<media:image>",
    });

    await deliverReplies({
      accountId: "acct-4",
      client,
      maxBytes: 2048,
      replies: [{ mediaUrls: ["https://example.com/a.jpg"] }],
      runtime,
      sentMessageCache: { remember },
      target: "chat_id:40",
      textLimit: 4000,
    });

    expect(remember).toHaveBeenCalledWith("acct-4:chat_id:40", {
      messageId: "imsg-media-1",
      text: "<media:image>",
    });
  });
});
