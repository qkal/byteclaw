import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const replyCommentMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
}));

vi.mock("./send.js", () => ({
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn(() => ({ request: vi.fn() })),
}));

vi.mock("./drive.js", () => ({
  replyComment: replyCommentMock,
}));

import { feishuOutbound } from "./outbound.js";
const sendText = feishuOutbound.sendText!;
const emptyConfig: ClawdbotConfig = {};
const cardRenderConfig: ClawdbotConfig = {
  channels: {
    feishu: {
      renderMode: "card",
    },
  },
};

function resetOutboundMocks() {
  vi.clearAllMocks();
  sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
  sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
  replyCommentMock.mockResolvedValue({ reply_id: "reply_msg" });
}

describe("feishuOutbound.sendText local-image auto-convert", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("chunks outbound text without requiring Feishu runtime initialization", () => {
    const {chunker} = feishuOutbound;
    if (!chunker) {
      throw new Error("feishuOutbound.chunker missing");
    }

    expect(() => chunker("hello world", 5)).not.toThrow();
    expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
  });

  async function createTmpImage(ext = ".png"): Promise<{ dir: string; file: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-outbound-"));
    const file = path.join(dir, `sample${ext}`);
    await fs.writeFile(file, "image-data");
    return { dir, file };
  }

  it("sends an absolute existing local image path as media", async () => {
    const { dir, file } = await createTmpImage();
    try {
      const result = await sendText({
        accountId: "main",
        cfg: emptyConfig,
        mediaLocalRoots: [dir],
        text: file,
        to: "chat_1",
      });

      expect(sendMediaFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "main",
          mediaLocalRoots: [dir],
          mediaUrl: file,
          to: "chat_1",
        }),
      );
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({ channel: "feishu", messageId: "media_msg" }),
      );
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps non-path text on the text-send path", async () => {
    await sendText({
      accountId: "main",
      cfg: emptyConfig,
      text: "please upload /tmp/example.png",
      to: "chat_1",
    });

    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        text: "please upload /tmp/example.png",
        to: "chat_1",
      }),
    );
  });

  it("falls back to plain text if local-image media send fails", async () => {
    const { dir, file } = await createTmpImage();
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    try {
      await sendText({
        accountId: "main",
        cfg: emptyConfig,
        text: file,
        to: "chat_1",
      });

      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "main",
          text: file,
          to: "chat_1",
        }),
      );
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  });

  it("uses markdown cards when renderMode=card", async () => {
    const result = await sendText({
      accountId: "main",
      cfg: cardRenderConfig,
      text: "| a | b |\n| - | - |",
      to: "chat_1",
    });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        text: "| a | b |\n| - | - |",
        to: "chat_1",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "card_msg" }));
  });

  it("forwards replyToId as replyToMessageId on sendText", async () => {
    await sendText({
      accountId: "main",
      cfg: emptyConfig,
      replyToId: "om_reply_1",
      text: "hello",
      to: "chat_1",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        replyToMessageId: "om_reply_1",
        text: "hello",
        to: "chat_1",
      }),
    );
  });

  it("falls back to threadId when replyToId is empty on sendText", async () => {
    await sendText({
      accountId: "main",
      cfg: emptyConfig,
      replyToId: " ",
      text: "hello",
      threadId: "om_thread_2",
      to: "chat_1",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        replyToMessageId: "om_thread_2",
        text: "hello",
        to: "chat_1",
      }),
    );
  });
});

describe("feishuOutbound comment-thread routing", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("routes comment-thread text through replyComment", async () => {
    const result = await sendText({
      accountId: "main",
      cfg: emptyConfig,
      text: "handled in thread",
      to: "comment:docx:doxcn123:7623358762119646411",
    });

    expect(replyCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        comment_id: "7623358762119646411",
        content: "handled in thread",
        file_token: "doxcn123",
        file_type: "docx",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "reply_msg" }));
  });

  it("routes comment-thread code-block replies through replyComment instead of IM cards", async () => {
    const result = await sendText({
      accountId: "main",
      cfg: emptyConfig,
      text: "```ts\nconst x = 1\n```",
      to: "comment:docx:doxcn123:7623358762119646411",
    });

    expect(replyCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        comment_id: "7623358762119646411",
        content: "```ts\nconst x = 1\n```",
        file_token: "doxcn123",
        file_type: "docx",
      }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "reply_msg" }));
  });

  it("routes comment-thread replies through replyComment even when renderMode=card", async () => {
    const result = await sendText({
      accountId: "main",
      cfg: cardRenderConfig,
      text: "handled in thread",
      to: "comment:docx:doxcn123:7623358762119646411",
    });

    expect(replyCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        comment_id: "7623358762119646411",
        content: "handled in thread",
        file_token: "doxcn123",
        file_type: "docx",
      }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "reply_msg" }));
  });

  it("falls back to a text-only comment reply for media payloads", async () => {
    const result = await feishuOutbound.sendMedia?.({
      accountId: "main",
      cfg: emptyConfig,
      mediaUrl: "https://example.com/file.png",
      text: "see attachment",
      to: "comment:docx:doxcn123:7623358762119646411",
    });

    expect(replyCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: "see attachment\n\nhttps://example.com/file.png",
      }),
    );
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "reply_msg" }));
  });
});

describe("feishuOutbound.sendText replyToId forwarding", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("forwards replyToId as replyToMessageId to sendMessageFeishu", async () => {
    await sendText({
      accountId: "main",
      cfg: emptyConfig,
      replyToId: "om_reply_target",
      text: "hello",
      to: "chat_1",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        replyToMessageId: "om_reply_target",
        text: "hello",
        to: "chat_1",
      }),
    );
  });

  it("forwards replyToId to sendStructuredCardFeishu when renderMode=card", async () => {
    await sendText({
      accountId: "main",
      cfg: cardRenderConfig,
      replyToId: "om_reply_target",
      text: "```code```",
      to: "chat_1",
    });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_target",
      }),
    );
  });

  it("does not pass replyToMessageId when replyToId is absent", async () => {
    await sendText({
      accountId: "main",
      cfg: emptyConfig,
      text: "hello",
      to: "chat_1",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        text: "hello",
        to: "chat_1",
      }),
    );
    expect(sendMessageFeishuMock.mock.calls[0][0].replyToMessageId).toBeUndefined();
  });
});

describe("feishuOutbound.sendMedia replyToId forwarding", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("forwards replyToId to sendMediaFeishu", async () => {
    await feishuOutbound.sendMedia?.({
      accountId: "main",
      cfg: emptyConfig,
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_reply_target",
      text: "",
      to: "chat_1",
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_target",
      }),
    );
  });

  it("forwards replyToId to text caption send", async () => {
    await feishuOutbound.sendMedia?.({
      accountId: "main",
      cfg: emptyConfig,
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_reply_target",
      text: "caption text",
      to: "chat_1",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_target",
      }),
    );
  });
});

describe("feishuOutbound.sendMedia renderMode", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("uses markdown cards for captions when renderMode=card", async () => {
    const result = await feishuOutbound.sendMedia?.({
      accountId: "main",
      cfg: cardRenderConfig,
      mediaUrl: "https://example.com/image.png",
      text: "| a | b |\n| - | - |",
      to: "chat_1",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        text: "| a | b |\n| - | - |",
        to: "chat_1",
      }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        mediaUrl: "https://example.com/image.png",
        to: "chat_1",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "media_msg" }));
  });

  it("uses threadId fallback as replyToMessageId on sendMedia", async () => {
    await feishuOutbound.sendMedia?.({
      accountId: "main",
      cfg: emptyConfig,
      mediaUrl: "https://example.com/image.png",
      text: "caption",
      threadId: "om_thread_1",
      to: "chat_1",
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        mediaUrl: "https://example.com/image.png",
        replyToMessageId: "om_thread_1",
        to: "chat_1",
      }),
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        replyToMessageId: "om_thread_1",
        text: "caption",
        to: "chat_1",
      }),
    );
  });
});
