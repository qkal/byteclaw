import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
}));
const loadWebMediaMock = vi.fn();
let sendMessageWhatsApp: typeof import("./send.js").sendMessageWhatsApp;
let sendPollWhatsApp: typeof import("./send.js").sendPollWhatsApp;
let sendReactionWhatsApp: typeof import("./send.js").sendReactionWhatsApp;
let setActiveWebListener: typeof import("./active-listener.js").setActiveWebListener;
let resetLogger: typeof import("openclaw/plugin-sdk/runtime-env").resetLogger;
let setLoggerOverride: typeof import("openclaw/plugin-sdk/runtime-env").setLoggerOverride;

vi.mock("./outbound-media.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-media.runtime.js")>(
    "./outbound-media.runtime.js",
  );
  return {
    ...actual,
    loadOutboundMediaFromUrl: hoisted.loadOutboundMediaFromUrl,
  };
});

describe("web outbound", () => {
  const sendComposingTo = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => ({ messageId: "msg123" }));
  const sendPoll = vi.fn(async () => ({ messageId: "poll123" }));
  const sendReaction = vi.fn(async () => {});

  beforeAll(async () => {
    ({ sendMessageWhatsApp, sendPollWhatsApp, sendReactionWhatsApp } = await import("./send.js"));
    ({ setActiveWebListener } = await import("./active-listener.js"));
    ({ resetLogger, setLoggerOverride } = await import("openclaw/plugin-sdk/runtime-env"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.loadOutboundMediaFromUrl.mockReset().mockImplementation(
      async (
        mediaUrl: string,
        options?: {
          maxBytes?: number;
          mediaAccess?: {
            localRoots?: readonly string[];
            readFile?: (filePath: string) => Promise<Buffer>;
          };
          mediaLocalRoots?: readonly string[];
          mediaReadFile?: (filePath: string) => Promise<Buffer>;
        },
      ) =>
        await loadWebMediaMock(mediaUrl, {
          hostReadCapability: Boolean(options?.mediaAccess?.readFile ?? options?.mediaReadFile),
          localRoots: options?.mediaAccess?.localRoots ?? options?.mediaLocalRoots,
          maxBytes: options?.maxBytes,
          readFile: options?.mediaAccess?.readFile ?? options?.mediaReadFile,
        }),
    );
    setActiveWebListener({
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    setActiveWebListener(null);
    setActiveWebListener("work", null);
  });

  it("sends message via active listener", async () => {
    const result = await sendMessageWhatsApp("+1555", "hi", { verbose: false });
    expect(result).toEqual({
      messageId: "msg123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendComposingTo).toHaveBeenCalledWith("+1555");
    expect(sendMessage).toHaveBeenCalledWith("+1555", "hi", undefined, undefined);
  });

  it("uses configured defaultAccount when outbound accountId is omitted", async () => {
    setActiveWebListener(null);
    setActiveWebListener("work", {
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });

    const result = await sendMessageWhatsApp("+1555", "hi", {
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              work: {},
            },
            defaultAccount: "work",
          },
        },
      } as OpenClawConfig,
      verbose: false,
    });

    expect(result).toEqual({
      messageId: "msg123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendMessage).toHaveBeenCalledWith("+1555", "hi", undefined, undefined);
  });

  it("trims leading whitespace before sending text and captions", async () => {
    await sendMessageWhatsApp("+1555", "\n \thello", { verbose: false });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "hello", undefined, undefined);

    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
    });
    await sendMessageWhatsApp("+1555", "\n \tcaption", {
      mediaUrl: "/tmp/pic.jpg",
      verbose: false,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "caption", buf, "image/jpeg");
  });

  it("skips whitespace-only text sends without media", async () => {
    const result = await sendMessageWhatsApp("+1555", "\n \t", { verbose: false });

    expect(result).toEqual({
      messageId: "",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendComposingTo).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("throws a helpful error when no active listener exists", async () => {
    setActiveWebListener(null);
    await expect(
      sendMessageWhatsApp("+1555", "hi", { accountId: "work", verbose: false }),
    ).rejects.toThrow(/No active WhatsApp Web listener/);
    await expect(
      sendMessageWhatsApp("+1555", "hi", { accountId: "work", verbose: false }),
    ).rejects.toThrow(/channels login/);
    await expect(
      sendMessageWhatsApp("+1555", "hi", { accountId: "work", verbose: false }),
    ).rejects.toThrow(/account: work/);
  });

  it("maps audio to PTT with opus mime when ogg", async () => {
    const buf = Buffer.from("audio");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "audio/ogg",
      kind: "audio",
    });
    await sendMessageWhatsApp("+1555", "voice note", {
      mediaUrl: "/tmp/voice.ogg",
      verbose: false,
    });
    expect(sendMessage).toHaveBeenLastCalledWith(
      "+1555",
      "voice note",
      buf,
      "audio/ogg; codecs=opus",
    );
  });

  it("maps video with caption", async () => {
    const buf = Buffer.from("video");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "video/mp4",
      kind: "video",
    });
    await sendMessageWhatsApp("+1555", "clip", {
      mediaUrl: "/tmp/video.mp4",
      verbose: false,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "clip", buf, "video/mp4");
  });

  it("marks gif playback for video when requested", async () => {
    const buf = Buffer.from("gifvid");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "video/mp4",
      kind: "video",
    });
    await sendMessageWhatsApp("+1555", "gif", {
      gifPlayback: true,
      mediaUrl: "/tmp/anim.mp4",
      verbose: false,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "gif", buf, "video/mp4", {
      gifPlayback: true,
    });
  });

  it("maps image with caption", async () => {
    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
    });
    await sendMessageWhatsApp("+1555", "pic", {
      mediaUrl: "/tmp/pic.jpg",
      verbose: false,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "pic", buf, "image/jpeg");
  });

  it("maps other kinds to document with filename", async () => {
    const buf = Buffer.from("pdf");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "application/pdf",
      fileName: "file.pdf",
      kind: "document",
    });
    await sendMessageWhatsApp("+1555", "doc", {
      mediaUrl: "/tmp/file.pdf",
      verbose: false,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "doc", buf, "application/pdf", {
      fileName: "file.pdf",
    });
  });

  it("uses account-aware WhatsApp media caps for outbound uploads", async () => {
    setActiveWebListener("work", {
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/jpeg",
      kind: "image",
    });

    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              mediaMaxMb: 100,
            },
          },
          mediaMaxMb: 25,
        },
      },
    } as OpenClawConfig;

    await sendMessageWhatsApp("+1555", "pic", {
      accountId: "work",
      cfg,
      mediaLocalRoots: ["/tmp/workspace"],
      mediaUrl: "/tmp/pic.jpg",
      verbose: false,
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "/tmp/pic.jpg",
      expect.objectContaining({
        localRoots: ["/tmp/workspace"],
        maxBytes: 100 * 1024 * 1024,
      }),
    );
  });

  it("sends polls via active listener", async () => {
    const result = await sendPollWhatsApp(
      "+1555",
      { maxSelections: 2, options: ["Pizza", "Sushi"], question: "Lunch?" },
      { verbose: false },
    );
    expect(result).toEqual({
      messageId: "poll123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendPoll).toHaveBeenCalledWith("+1555", {
      durationHours: undefined,
      durationSeconds: undefined,
      maxSelections: 2,
      options: ["Pizza", "Sushi"],
      question: "Lunch?",
    });
  });

  it("redacts recipients and poll text in outbound logs", async () => {
    const logPath = path.join(os.tmpdir(), `openclaw-outbound-${crypto.randomUUID()}.log`);
    setLoggerOverride({ file: logPath, level: "trace" });

    await sendPollWhatsApp(
      "+1555",
      { maxSelections: 1, options: ["Pizza", "Sushi"], question: "Lunch?" },
      { verbose: false },
    );

    await vi.waitFor(
      () => {
        expect(fsSync.existsSync(logPath)).toBe(true);
      },
      { interval: 5, timeout: 2000 },
    );

    const content = fsSync.readFileSync(logPath, "utf8");
    expect(content).toContain(redactIdentifier("+1555"));
    expect(content).toContain(redactIdentifier("1555@s.whatsapp.net"));
    expect(content).not.toContain(`"to":"+1555"`);
    expect(content).not.toContain(`"jid":"1555@s.whatsapp.net"`);
    expect(content).not.toContain("Lunch?");
  });

  it("sends reactions via active listener", async () => {
    await sendReactionWhatsApp("1555@s.whatsapp.net", "msg123", "✅", {
      fromMe: false,
      verbose: false,
    });
    expect(sendReaction).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      "msg123",
      "✅",
      false,
      undefined,
    );
  });
});
