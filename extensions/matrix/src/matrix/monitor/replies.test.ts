import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import type { MatrixClient } from "../sdk.js";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "mx-1" }));
const chunkMatrixTextMock = vi.hoisted(() =>
  vi.fn((text: string, _opts?: unknown) => ({
    chunks: text ? [text] : [],
    convertedText: text,
    fitsInSingleEvent: true,
    singleEventLimit: 4000,
    trimmedText: text.trim(),
  })),
);

vi.mock("../send.js", () => ({
  chunkMatrixText: (text: string, opts?: unknown) => chunkMatrixTextMock(text, opts),
  sendMessageMatrix: (to: string, message: string, opts?: unknown) =>
    sendMessageMatrixMock(to, message, opts),
}));

import { setMatrixRuntime } from "../../runtime.js";
import { deliverMatrixReplies } from "./replies.js";

describe("deliverMatrixReplies", () => {
  const cfg = { channels: { matrix: {} } };
  const loadConfigMock = vi.fn(() => ({}));
  const resolveMarkdownTableModeMock = vi.fn<(params: unknown) => string>(() => "code");
  const convertMarkdownTablesMock = vi.fn((text: string) => text);
  const resolveChunkModeMock = vi.fn<
    (cfg: unknown, channel: unknown, accountId?: unknown) => string
  >(() => "length");
  const chunkMarkdownTextWithModeMock = vi.fn((text: string) => [text]);

  const runtimeStub = {
    channel: {
      text: {
        chunkMarkdownTextWithMode: (text: string) => chunkMarkdownTextWithModeMock(text),
        convertMarkdownTables: (text: string) => convertMarkdownTablesMock(text),
        resolveChunkMode: (cfg: unknown, channel: unknown, accountId?: unknown) =>
          resolveChunkModeMock(cfg, channel, accountId),
        resolveMarkdownTableMode: (params: unknown) => resolveMarkdownTableModeMock(params),
      },
    },
    config: {
      loadConfig: () => loadConfigMock(),
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;

  const runtimeEnv: RuntimeEnv = {
    error: vi.fn(),
    log: vi.fn(),
  } as unknown as RuntimeEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    setMatrixRuntime(runtimeStub);
    chunkMatrixTextMock.mockReset().mockImplementation((text: string) => ({
      chunks: text ? [text] : [],
      convertedText: text,
      fitsInSingleEvent: true,
      singleEventLimit: 4000,
      trimmedText: text.trim(),
    }));
  });

  it("keeps replyToId on first reply only when replyToMode=first", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      chunks: text.split("|"),
      convertedText: text,
      fitsInSingleEvent: true,
      singleEventLimit: 4000,
      trimmedText: text.trim(),
    }));

    await deliverMatrixReplies({
      cfg,
      client: {} as MatrixClient,
      replies: [
        { replyToId: "reply-1", text: "first-a|first-b" },
        { replyToId: "reply-2", text: "second" },
      ],
      replyToMode: "first",
      roomId: "room:1",
      runtime: runtimeEnv,
      textLimit: 4000,
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendMessageMatrixMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-1", threadId: undefined }),
    );
    expect(sendMessageMatrixMock.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-1", threadId: undefined }),
    );
    expect(sendMessageMatrixMock.mock.calls[2]?.[2]).toEqual(
      expect.objectContaining({ replyToId: undefined, threadId: undefined }),
    );
  });

  it("keeps replyToId on every reply when replyToMode=all", async () => {
    await deliverMatrixReplies({
      cfg,
      client: {} as MatrixClient,
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      replies: [
        {
          audioAsVoice: true,
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          replyToId: "reply-media",
          text: "caption",
        },
        { replyToId: "reply-text", text: "plain" },
      ],
      replyToMode: "all",
      roomId: "room:2",
      runtime: runtimeEnv,
      textLimit: 4000,
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendMessageMatrixMock.mock.calls[0]).toEqual([
      "room:2",
      "caption",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
        mediaUrl: "https://example.com/a.jpg",
        replyToId: "reply-media",
      }),
    ]);
    expect(sendMessageMatrixMock.mock.calls[1]).toEqual([
      "room:2",
      "",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
        mediaUrl: "https://example.com/b.jpg",
        replyToId: "reply-media",
      }),
    ]);
    expect(sendMessageMatrixMock.mock.calls[2]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-text" }),
    );
  });

  it("suppresses replyToId when threadId is set", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      chunks: text.split("|"),
      convertedText: text,
      fitsInSingleEvent: true,
      singleEventLimit: 4000,
      trimmedText: text.trim(),
    }));

    await deliverMatrixReplies({
      cfg,
      client: {} as MatrixClient,
      replies: [{ replyToId: "reply-thread", text: "hello|thread" }],
      replyToMode: "all",
      roomId: "room:3",
      runtime: runtimeEnv,
      textLimit: 4000,
      threadId: "thread-77",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMatrixMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ replyToId: undefined, threadId: "thread-77" }),
    );
    expect(sendMessageMatrixMock.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ replyToId: undefined, threadId: "thread-77" }),
    );
  });

  it("suppresses reasoning-only text before Matrix sends", async () => {
    await deliverMatrixReplies({
      cfg,
      client: {} as MatrixClient,
      replies: [
        { text: "Reasoning:\n_hidden_" },
        { text: "<think>still hidden</think>" },
        { text: "Visible answer" },
      ],
      replyToMode: "off",
      roomId: "room:5",
      runtime: runtimeEnv,
      textLimit: 4000,
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "room:5",
      "Visible answer",
      expect.objectContaining({ cfg }),
    );
  });

  it("uses supplied cfg for chunking and send delivery without reloading runtime config", async () => {
    const explicitCfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              chunkMode: "newline",
            },
          },
        },
      },
    };
    loadConfigMock.mockImplementation(() => {
      throw new Error("deliverMatrixReplies should not reload runtime config when cfg is provided");
    });

    await deliverMatrixReplies({
      accountId: "ops",
      cfg: explicitCfg,
      client: {} as MatrixClient,
      replies: [{ replyToId: "reply-1", text: "hello" }],
      replyToMode: "all",
      roomId: "room:4",
      runtime: runtimeEnv,
      textLimit: 4000,
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(chunkMatrixTextMock).toHaveBeenCalledWith("hello", {
      accountId: "ops",
      cfg: explicitCfg,
      tableMode: "code",
    });
    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "room:4",
      "hello",
      expect.objectContaining({
        accountId: "ops",
        cfg: explicitCfg,
        replyToId: "reply-1",
      }),
    );
  });

  it("passes raw media captions through to sendMessageMatrix without pre-converting them", async () => {
    convertMarkdownTablesMock.mockImplementation((text: string) => `converted:${text}`);

    await deliverMatrixReplies({
      cfg,
      client: {} as MatrixClient,
      replies: [{ mediaUrl: "https://example.com/a.jpg", text: "caption" }],
      replyToMode: "off",
      roomId: "room:6",
      runtime: runtimeEnv,
      textLimit: 4000,
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "room:6",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/a.jpg",
      }),
    );
  });
});
