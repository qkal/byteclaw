import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendDeliveredZalouser,
  sendImageZalouser,
  sendLinkZalouser,
  sendMessageZalouser,
  sendReactionZalouser,
  sendSeenZalouser,
  sendTypingZalouser,
} from "./send.js";
import { parseZalouserTextStyles } from "./text-styles.js";
import {
  sendZaloDeliveredEvent,
  sendZaloLink,
  sendZaloReaction,
  sendZaloSeenEvent,
  sendZaloTextMessage,
  sendZaloTypingEvent,
} from "./zalo-js.js";
import { TextStyle } from "./zca-constants.js";

vi.mock("./zalo-js.js", () => ({
  sendZaloDeliveredEvent: vi.fn(),
  sendZaloLink: vi.fn(),
  sendZaloReaction: vi.fn(),
  sendZaloSeenEvent: vi.fn(),
  sendZaloTextMessage: vi.fn(),
  sendZaloTypingEvent: vi.fn(),
}));

const mockSendText = vi.mocked(sendZaloTextMessage);
const mockSendLink = vi.mocked(sendZaloLink);
const mockSendTyping = vi.mocked(sendZaloTypingEvent);
const mockSendReaction = vi.mocked(sendZaloReaction);
const mockSendDelivered = vi.mocked(sendZaloDeliveredEvent);
const mockSendSeen = vi.mocked(sendZaloSeenEvent);

describe("zalouser send helpers", () => {
  beforeEach(() => {
    mockSendText.mockReset();
    mockSendLink.mockReset();
    mockSendTyping.mockReset();
    mockSendReaction.mockReset();
    mockSendDelivered.mockReset();
    mockSendSeen.mockReset();
  });

  it("keeps plain text literal by default", async () => {
    mockSendText.mockResolvedValueOnce({ messageId: "mid-1", ok: true });

    const result = await sendMessageZalouser("thread-1", "**hello**", {
      isGroup: true,
      profile: "default",
    });

    expect(mockSendText).toHaveBeenCalledWith(
      "thread-1",
      "**hello**",
      expect.objectContaining({
        isGroup: true,
        profile: "default",
      }),
    );
    expect(result).toEqual({ messageId: "mid-1", ok: true });
  });

  it("formats markdown text when markdown mode is enabled", async () => {
    mockSendText.mockResolvedValueOnce({ messageId: "mid-1b", ok: true });

    await sendMessageZalouser("thread-1", "**hello**", {
      isGroup: true,
      profile: "default",
      textMode: "markdown",
    });

    expect(mockSendText).toHaveBeenCalledWith(
      "thread-1",
      "hello",
      expect.objectContaining({
        isGroup: true,
        profile: "default",
        textMode: "markdown",
        textStyles: [{ len: 5, st: TextStyle.Bold, start: 0 }],
      }),
    );
  });

  it("formats image captions in markdown mode", async () => {
    mockSendText.mockResolvedValueOnce({ messageId: "mid-2", ok: true });

    await sendImageZalouser("thread-2", "https://example.com/a.png", {
      caption: "_cap_",
      isGroup: false,
      profile: "p2",
      textMode: "markdown",
    });

    expect(mockSendText).toHaveBeenCalledWith(
      "thread-2",
      "cap",
      expect.objectContaining({
        caption: undefined,
        isGroup: false,
        mediaUrl: "https://example.com/a.png",
        profile: "p2",
        textMode: "markdown",
        textStyles: [{ len: 3, st: TextStyle.Italic, start: 0 }],
      }),
    );
  });

  it("does not keep the raw markdown caption as a media fallback after formatting", async () => {
    mockSendText.mockResolvedValueOnce({ messageId: "mid-2b", ok: true });

    await sendImageZalouser("thread-2", "https://example.com/a.png", {
      caption: "```\n```",
      isGroup: false,
      profile: "p2",
      textMode: "markdown",
    });

    expect(mockSendText).toHaveBeenCalledWith(
      "thread-2",
      "",
      expect.objectContaining({
        caption: undefined,
        isGroup: false,
        mediaUrl: "https://example.com/a.png",
        profile: "p2",
        textMode: "markdown",
        textStyles: undefined,
      }),
    );
  });

  it("rechunks normalized markdown text before sending to avoid transport truncation", async () => {
    const text = "\t".repeat(500) + "a".repeat(1500);
    const formatted = parseZalouserTextStyles(text);
    mockSendText
      .mockResolvedValueOnce({ messageId: "mid-2c-1", ok: true })
      .mockResolvedValueOnce({ messageId: "mid-2c-2", ok: true });

    const result = await sendMessageZalouser("thread-2c", text, {
      isGroup: false,
      profile: "p2c",
      textMode: "markdown",
    });

    expect(formatted.text.length).toBeGreaterThan(2000);
    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText.mock.calls.map((call) => call[1]).join("")).toBe(formatted.text);
    expect(mockSendText.mock.calls.every((call) => call[1].length <= 2000)).toBe(true);
    expect(result).toEqual({ messageId: "mid-2c-2", ok: true });
  });

  it("preserves text styles when splitting long formatted markdown", async () => {
    const text = `**${"a".repeat(2501)}**`;
    mockSendText
      .mockResolvedValueOnce({ messageId: "mid-2d-1", ok: true })
      .mockResolvedValueOnce({ messageId: "mid-2d-2", ok: true });

    const result = await sendMessageZalouser("thread-2d", text, {
      isGroup: false,
      profile: "p2d",
      textMode: "markdown",
    });

    expect(mockSendText).toHaveBeenNthCalledWith(
      1,
      "thread-2d",
      "a".repeat(2000),
      expect.objectContaining({
        isGroup: false,
        profile: "p2d",
        textMode: "markdown",
        textStyles: [{ len: 2000, st: TextStyle.Bold, start: 0 }],
      }),
    );
    expect(mockSendText).toHaveBeenNthCalledWith(
      2,
      "thread-2d",
      "a".repeat(501),
      expect.objectContaining({
        isGroup: false,
        profile: "p2d",
        textMode: "markdown",
        textStyles: [{ len: 501, st: TextStyle.Bold, start: 0 }],
      }),
    );
    expect(result).toEqual({ messageId: "mid-2d-2", ok: true });
  });

  it("preserves formatted text and styles when newline chunk mode splits after parsing", async () => {
    const text = `**${"a".repeat(1995)}**\n\nsecond paragraph`;
    const formatted = parseZalouserTextStyles(text);
    mockSendText
      .mockResolvedValueOnce({ messageId: "mid-2d-3", ok: true })
      .mockResolvedValueOnce({ messageId: "mid-2d-4", ok: true });

    const result = await sendMessageZalouser("thread-2d-2", text, {
      isGroup: false,
      profile: "p2d-2",
      textChunkMode: "newline",
      textMode: "markdown",
    });

    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText.mock.calls.map((call) => call[1]).join("")).toBe(formatted.text);
    expect(mockSendText).toHaveBeenNthCalledWith(
      1,
      "thread-2d-2",
      `${"a".repeat(1995)}\n\n`,
      expect.objectContaining({
        isGroup: false,
        profile: "p2d-2",
        textChunkMode: "newline",
        textMode: "markdown",
        textStyles: [{ len: 1995, st: TextStyle.Bold, start: 0 }],
      }),
    );
    expect(mockSendText).toHaveBeenNthCalledWith(
      2,
      "thread-2d-2",
      "second paragraph",
      expect.objectContaining({
        isGroup: false,
        profile: "p2d-2",
        textChunkMode: "newline",
        textMode: "markdown",
        textStyles: undefined,
      }),
    );
    expect(result).toEqual({ messageId: "mid-2d-4", ok: true });
  });

  it("respects an explicit text chunk limit when splitting formatted markdown", async () => {
    const text = `**${"a".repeat(1501)}**`;
    mockSendText
      .mockResolvedValueOnce({ messageId: "mid-2d-5", ok: true })
      .mockResolvedValueOnce({ messageId: "mid-2d-6", ok: true });

    const result = await sendMessageZalouser("thread-2d-3", text, {
      isGroup: false,
      profile: "p2d-3",
      textChunkLimit: 1200,
      textMode: "markdown",
    } as never);

    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText).toHaveBeenNthCalledWith(
      1,
      "thread-2d-3",
      "a".repeat(1200),
      expect.objectContaining({
        isGroup: false,
        profile: "p2d-3",
        textChunkLimit: 1200,
        textMode: "markdown",
        textStyles: [{ len: 1200, st: TextStyle.Bold, start: 0 }],
      }),
    );
    expect(mockSendText).toHaveBeenNthCalledWith(
      2,
      "thread-2d-3",
      "a".repeat(301),
      expect.objectContaining({
        isGroup: false,
        profile: "p2d-3",
        textChunkLimit: 1200,
        textMode: "markdown",
        textStyles: [{ len: 301, st: TextStyle.Bold, start: 0 }],
      }),
    );
    expect(result).toEqual({ messageId: "mid-2d-6", ok: true });
  });

  it("sends overflow markdown captions as follow-up text after the media message", async () => {
    const caption = "\t".repeat(500) + "a".repeat(1500);
    const formatted = parseZalouserTextStyles(caption);
    mockSendText
      .mockResolvedValueOnce({ messageId: "mid-2e-1", ok: true })
      .mockResolvedValueOnce({ messageId: "mid-2e-2", ok: true });

    const result = await sendImageZalouser("thread-2e", "https://example.com/long.png", {
      caption,
      isGroup: false,
      profile: "p2e",
      textMode: "markdown",
    });

    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText.mock.calls.map((call) => call[1]).join("")).toBe(formatted.text);
    expect(mockSendText).toHaveBeenNthCalledWith(
      1,
      "thread-2e",
      expect.any(String),
      expect.objectContaining({
        caption: undefined,
        isGroup: false,
        mediaUrl: "https://example.com/long.png",
        profile: "p2e",
        textMode: "markdown",
      }),
    );
    expect(mockSendText).toHaveBeenNthCalledWith(
      2,
      "thread-2e",
      expect.any(String),
      expect.not.objectContaining({
        mediaUrl: "https://example.com/long.png",
      }),
    );
    expect(result).toEqual({ messageId: "mid-2e-2", ok: true });
  });

  it("delegates link helper to JS transport", async () => {
    mockSendLink.mockResolvedValueOnce({ error: "boom", ok: false });

    const result = await sendLinkZalouser("thread-3", "https://openclaw.ai", {
      isGroup: true,
      profile: "p3",
    });

    expect(mockSendLink).toHaveBeenCalledWith("thread-3", "https://openclaw.ai", {
      isGroup: true,
      profile: "p3",
    });
    expect(result).toEqual({ error: "boom", ok: false });
  });

  it("delegates typing helper to JS transport", async () => {
    await sendTypingZalouser("thread-4", { isGroup: true, profile: "p4" });

    expect(mockSendTyping).toHaveBeenCalledWith("thread-4", {
      isGroup: true,
      profile: "p4",
    });
  });

  it("delegates reaction helper to JS transport", async () => {
    mockSendReaction.mockResolvedValueOnce({ ok: true });

    const result = await sendReactionZalouser({
      cliMsgId: "200",
      emoji: "👍",
      isGroup: true,
      msgId: "100",
      profile: "p5",
      threadId: "thread-5",
    });

    expect(mockSendReaction).toHaveBeenCalledWith({
      cliMsgId: "200",
      emoji: "👍",
      isGroup: true,
      msgId: "100",
      profile: "p5",
      remove: undefined,
      threadId: "thread-5",
    });
    expect(result).toEqual({ error: undefined, ok: true });
  });

  it("delegates delivered+seen helpers to JS transport", async () => {
    mockSendDelivered.mockResolvedValueOnce();
    mockSendSeen.mockResolvedValueOnce();

    const message = {
      at: 0,
      cliMsgId: "200",
      cmd: 0,
      idTo: "2",
      msgId: "100",
      msgType: "webchat",
      st: 1,
      ts: "123",
      uidFrom: "1",
    };

    await sendDeliveredZalouser({ isGroup: true, isSeen: false, message, profile: "p6" });
    await sendSeenZalouser({ isGroup: true, message, profile: "p6" });

    expect(mockSendDelivered).toHaveBeenCalledWith({
      isGroup: true,
      isSeen: false,
      message,
      profile: "p6",
    });
    expect(mockSendSeen).toHaveBeenCalledWith({
      isGroup: true,
      message,
      profile: "p6",
    });
  });
});
