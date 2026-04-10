import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
} from "./handler.test-helpers.js";

const { downloadMatrixMediaMock } = vi.hoisted(() => ({
  downloadMatrixMediaMock: vi.fn(),
}));

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return {
    ...actual,
    downloadMatrixMedia: (...args: unknown[]) => downloadMatrixMediaMock(...args),
  };
});

function createMediaFailureHarness() {
  const logger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const runtime = {
    error: vi.fn(),
  };
  const harness = createMatrixHandlerTestHarness({
    getMemberDisplayName: async () => "Gum",
    getRoomInfo: async () => ({
      altAliases: [],
      canonicalAlias: "#media:example.org",
      name: "Media Room",
    }),
    logger: logger as never,
    mediaMaxBytes: 5 * 1024 * 1024,
    readSessionUpdatedAt: () => 123,
    replyToMode: "first",
    resolveAgentRoute: () => ({
      accountId: "ops",
      agentId: "main",
      channel: "matrix",
      mainSessionKey: "agent:main:main",
      matchedBy: "binding.account",
      sessionKey: "agent:main:matrix:channel:!room:example.org",
    }),
    resolveMarkdownTableMode: () => "code",
    resolveStorePath: () => "/tmp/openclaw-test-session.json",
    runtime: runtime as never,
    shouldHandleTextCommands: () => true,
    startupGraceMs: 60_000,
    startupMs: Date.now() - 120_000,
    textLimit: 4000,
  });

  return {
    ...harness,
    logger,
    runtime,
  };
}

function createImageEvent(content: Record<string, unknown>) {
  return createMatrixRoomMessageEvent({
    content: {
      ...content,
      "m.mentions": { user_ids: ["@bot:matrix.example.org"] },
    } as never,
    eventId: "$event1",
    sender: "@gum:matrix.example.org",
  });
}

describe("createMatrixRoomMessageHandler media failures", () => {
  beforeEach(() => {
    downloadMatrixMediaMock.mockReset();
    installMatrixMonitorTestRuntime();
  });

  it("forwards the Matrix event body as originalFilename for media downloads", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      contentType: "image/png",
      path: "/tmp/inbound/Screenshot-2026-03-27---uuid.png",
      placeholder: "[matrix media]",
    });
    const { handler } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        body: " Screenshot 2026-03-27.png ",
        msgtype: "m.image",
        url: "mxc://example/image",
      }),
    );

    expect(downloadMatrixMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBytes: 5 * 1024 * 1024,
        mxcUrl: "mxc://example/image",
        originalFilename: "Screenshot 2026-03-27.png",
      }),
    );
  });

  it("prefers content.filename over body text when deriving originalFilename", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      contentType: "image/png",
      path: "/tmp/inbound/Screenshot-2026-03-27---uuid.png",
      placeholder: "[matrix media]",
    });
    const { handler } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        body: "can you review this screenshot?",
        filename: "Screenshot 2026-03-27.png",
        msgtype: "m.image",
        url: "mxc://example/image",
      }),
    );

    expect(downloadMatrixMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        originalFilename: "Screenshot 2026-03-27.png",
      }),
    );
  });

  it("replaces bare image filenames with an unavailable marker when unencrypted download fails", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("download failed"));
    const { handler, recordInboundSession, logger, runtime } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        body: "image.png",
        msgtype: "m.image",
        url: "mxc://example/image",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          CommandBody: "[matrix image attachment unavailable]",
          MediaPath: undefined,
          RawBody: "[matrix image attachment unavailable]",
        }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix media download failed",
      expect.objectContaining({
        encrypted: false,
        eventId: "$event1",
        msgtype: "m.image",
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("replaces bare image filenames with an unavailable marker when encrypted download fails", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("decrypt failed"));
    const { handler, recordInboundSession } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        body: "photo.jpg",
        file: {
          hashes: { sha256: "hash" },
          iv: "iv",
          key: { alg: "A256CTR", ext: true, k: "secret", key_ops: ["encrypt"], kty: "oct" },
          url: "mxc://example/encrypted",
          v: "v2",
        },
        msgtype: "m.image",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          CommandBody: "[matrix image attachment unavailable]",
          MediaPath: undefined,
          RawBody: "[matrix image attachment unavailable]",
        }),
      }),
    );
  });

  it("preserves a real caption while marking the attachment unavailable", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("download failed"));
    const { handler, recordInboundSession } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        body: "can you see this image?",
        filename: "image.png",
        msgtype: "m.image",
        url: "mxc://example/image",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          CommandBody: "can you see this image?\n\n[matrix image attachment unavailable]",
          RawBody: "can you see this image?\n\n[matrix image attachment unavailable]",
        }),
      }),
    );
  });

  it("shows a too-large marker when the download is rejected due to size limit", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new MatrixMediaSizeLimitError());
    const { handler, recordInboundSession } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        body: "big-photo.jpg",
        msgtype: "m.image",
        url: "mxc://example/big-image",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          CommandBody: "[matrix image attachment too large]",
          MediaPath: undefined,
          RawBody: "[matrix image attachment too large]",
        }),
      }),
    );
  });

  it("preserves a real caption while marking the attachment too large on size limit error", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new MatrixMediaSizeLimitError());
    const { handler, recordInboundSession } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        body: "check this out",
        filename: "large-photo.jpg",
        msgtype: "m.image",
        url: "mxc://example/big-image",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          CommandBody: "check this out\n\n[matrix image attachment too large]",
          RawBody: "check this out\n\n[matrix image attachment too large]",
        }),
      }),
    );
  });
});
