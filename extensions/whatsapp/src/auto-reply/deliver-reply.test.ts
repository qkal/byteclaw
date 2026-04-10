import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { sleep } from "openclaw/plugin-sdk/text-runtime";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadWebMedia } from "../media.js";
import type { WebInboundMsg } from "./types.js";

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: vi.fn(),
    shouldLogVerbose: vi.fn(() => true),
  };
});

vi.mock("openclaw/plugin-sdk/text-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/text-runtime")>(
    "openclaw/plugin-sdk/text-runtime",
  );
  return {
    ...actual,
    sleep: vi.fn(async () => {}),
  };
});

vi.mock("../media.js", () => ({
  loadWebMedia: vi.fn(),
}));

let deliverWebReply: typeof import("./deliver-reply.js").deliverWebReply;

function makeMsg(): WebInboundMsg {
  return {
    from: "+10000000000",
    id: "msg-1",
    reply: vi.fn(async () => undefined),
    sendMedia: vi.fn(async () => undefined),
    to: "+20000000000",
  } as unknown as WebInboundMsg;
}

function mockLoadedImageMedia() {
  (
    loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
  ).mockResolvedValueOnce({
    buffer: Buffer.from("img"),
    contentType: "image/jpeg",
    kind: "image",
  });
}

function mockFirstSendMediaFailure(msg: WebInboundMsg, message: string) {
  (
    msg.sendMedia as unknown as { mockRejectedValueOnce: (v: unknown) => void }
  ).mockRejectedValueOnce(new Error(message));
}

function mockFirstReplyFailure(msg: WebInboundMsg, message: string) {
  (msg.reply as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
    new Error(message),
  );
}

function mockSecondReplySuccess(msg: WebInboundMsg) {
  (msg.reply as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
    undefined,
  );
}

const replyLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

async function expectReplySuppressed(replyResult: { text: string; isReasoning?: boolean }) {
  const msg = makeMsg();
  await deliverWebReply({
    maxMediaBytes: 1024 * 1024,
    msg,
    replyLogger,
    replyResult,
    skipLog: true,
    textLimit: 200,
  });
  expect(msg.reply).not.toHaveBeenCalled();
  expect(msg.sendMedia).not.toHaveBeenCalled();
}

describe("deliverWebReply", () => {
  beforeAll(async () => {
    ({ deliverWebReply } = await import("./deliver-reply.js"));
  });

  it("suppresses payloads flagged as reasoning", async () => {
    await expectReplySuppressed({ isReasoning: true, text: "Reasoning:\n_hidden_" });
  });

  it("suppresses payloads that start with reasoning prefix text", async () => {
    await expectReplySuppressed({ text: "   \n Reasoning:\n_hidden_" });
  });

  it("does not suppress messages that mention Reasoning: mid-text", async () => {
    const msg = makeMsg();

    await deliverWebReply({
      maxMediaBytes: 1024 * 1024,
      msg,
      replyLogger,
      replyResult: { text: "Intro line\nReasoning: appears in content but is not a prefix" },
      skipLog: true,
      textLimit: 200,
    });

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith(
      "Intro line\nReasoning: appears in content but is not a prefix",
    );
  });

  it("sends chunked text replies and logs a summary", async () => {
    const msg = makeMsg();

    await deliverWebReply({
      maxMediaBytes: 1024 * 1024,
      msg,
      replyLogger,
      replyResult: { text: "aaaaaa" },
      skipLog: true,
      textLimit: 3,
    });

    expect(msg.reply).toHaveBeenCalledTimes(2);
    expect(msg.reply).toHaveBeenNthCalledWith(1, "aaa");
    expect(msg.reply).toHaveBeenNthCalledWith(2, "aaa");
    expect(replyLogger.info).toHaveBeenCalledWith(expect.any(Object), "auto-reply sent (text)");
  });

  it.each(["connection closed", "operation timed out"])(
    "retries text send on transient failure: %s",
    async (errorMessage) => {
      const msg = makeMsg();
      mockFirstReplyFailure(msg, errorMessage);
      mockSecondReplySuccess(msg);

      await deliverWebReply({
        maxMediaBytes: 1024 * 1024,
        msg,
        replyLogger,
        replyResult: { text: "hi" },
        skipLog: true,
        textLimit: 200,
      });

      expect(msg.reply).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(500);
    },
  );

  it("sends image media with caption and then remaining text", async () => {
    const msg = makeMsg();
    const mediaLocalRoots = ["/tmp/workspace-work"];
    mockLoadedImageMedia();

    await deliverWebReply({
      maxMediaBytes: 1024 * 1024,
      mediaLocalRoots,
      msg,
      replyLogger,
      replyResult: { mediaUrl: "http://example.com/img.jpg", text: "aaaaaa" },
      skipLog: true,
      textLimit: 3,
    });

    expect(loadWebMedia).toHaveBeenCalledWith("http://example.com/img.jpg", {
      localRoots: mediaLocalRoots,
      maxBytes: 1024 * 1024,
    });

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "aaa",
        image: expect.any(Buffer),
        mimetype: "image/jpeg",
      }),
    );
    expect(msg.reply).toHaveBeenCalledWith("aaa");
    expect(replyLogger.info).toHaveBeenCalledWith(expect.any(Object), "auto-reply sent (media)");
    expect(logVerbose).toHaveBeenCalled();
  });

  it("retries media send on transient failure", async () => {
    const msg = makeMsg();
    mockLoadedImageMedia();
    mockFirstSendMediaFailure(msg, "socket reset");
    (
      msg.sendMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce(undefined);

    await deliverWebReply({
      maxMediaBytes: 1024 * 1024,
      msg,
      replyLogger,
      replyResult: { mediaUrl: "http://example.com/img.jpg", text: "caption" },
      skipLog: true,
      textLimit: 200,
    });

    expect(msg.sendMedia).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("falls back to text-only when the first media send fails", async () => {
    const msg = makeMsg();
    mockLoadedImageMedia();
    mockFirstSendMediaFailure(msg, "boom");

    await deliverWebReply({
      maxMediaBytes: 1024 * 1024,
      msg,
      replyLogger,
      replyResult: { mediaUrl: "http://example.com/img.jpg", text: "caption" },
      skipLog: true,
      textLimit: 20,
    });

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(
      String((msg.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]),
    ).toContain("⚠️ Media failed");
    expect(replyLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "http://example.com/img.jpg" }),
      "failed to send web media reply",
    );
  });

  it("sends audio media as ptt voice note", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("aud"),
      contentType: "audio/ogg",
      kind: "audio",
    });

    await deliverWebReply({
      maxMediaBytes: 1024 * 1024,
      msg,
      replyLogger,
      replyResult: { mediaUrl: "http://example.com/a.ogg", text: "cap" },
      skipLog: true,
      textLimit: 200,
    });

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.any(Buffer),
        caption: "cap",
        mimetype: "audio/ogg",
        ptt: true,
      }),
    );
  });

  it("sends video media", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("vid"),
      contentType: "video/mp4",
      kind: "video",
    });

    await deliverWebReply({
      maxMediaBytes: 1024 * 1024,
      msg,
      replyLogger,
      replyResult: { mediaUrl: "http://example.com/v.mp4", text: "cap" },
      skipLog: true,
      textLimit: 200,
    });

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "cap",
        mimetype: "video/mp4",
        video: expect.any(Buffer),
      }),
    );
  });

  it("sends non-audio/image/video media as document", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("bin"),
      contentType: undefined,
      fileName: "x.bin",
      kind: "file",
    });

    await deliverWebReply({
      maxMediaBytes: 1024 * 1024,
      msg,
      replyLogger,
      replyResult: { mediaUrl: "http://example.com/x.bin", text: "cap" },
      skipLog: true,
      textLimit: 200,
    });

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "cap",
        document: expect.any(Buffer),
        fileName: "x.bin",
        mimetype: "application/octet-stream",
      }),
    );
  });
});
