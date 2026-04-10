import { describe, expect, it, vi } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";

const transcribeFirstAudioMock = vi.fn();

vi.mock("./media-understanding.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

const { resolveTelegramInboundBody } = await import("./bot-message-context.body.js");

describe("resolveTelegramInboundBody", () => {
  it("keeps the media marker when a captioned video has no downloaded media", async () => {
    const result = await resolveTelegramInboundBody({
      allMedia: [],
      cfg: {
        channels: { telegram: {} },
      } as never,
      chatId: 42,
      effectiveDmAllow: normalizeAllowFrom([]),
      effectiveGroupAllow: normalizeAllowFrom([]),
      groupConfig: undefined,
      groupHistories: new Map(),
      historyLimit: 0,
      isGroup: false,
      logger: { info: vi.fn() },
      msg: {
        caption: "episode caption",
        chat: { first_name: "Pat", id: 42, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Pat", id: 42 },
        message_id: 0,
        video: {
          duration: 10,
          file_id: "video-1",
          file_unique_id: "video-u1",
          height: 240,
          width: 320,
        },
      } as never,
      options: undefined,
      primaryCtx: {
        me: { id: 7, username: "bot" },
      } as never,
      requireMention: false,
      routeAgentId: undefined,
      senderId: "42",
      senderUsername: "",
      topicConfig: undefined,
    });

    expect(result).toMatchObject({
      bodyText: "<media:video> [file_id:video-1]\nepisode caption",
      rawBody: "episode caption",
    });
  });

  it("does not transcribe group audio for unauthorized senders", async () => {
    transcribeFirstAudioMock.mockReset();
    const logger = { info: vi.fn() };

    const result = await resolveTelegramInboundBody({
      allMedia: [{ contentType: "audio/ogg", path: "/tmp/voice.ogg" }],
      cfg: {
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: [String.raw`\bbot\b`] } },
      } as never,
      chatId: -1_001_234_567_890,
      effectiveDmAllow: normalizeAllowFrom([]),
      effectiveGroupAllow: normalizeAllowFrom(["999"]),
      groupConfig: { requireMention: true } as never,
      groupHistories: new Map(),
      historyLimit: 0,
      isGroup: true,
      logger,
      msg: {
        chat: { id: -1001234567890, title: "Test Group", type: "supergroup" },
        date: 1_700_000_000,
        entities: [],
        from: { first_name: "Eve", id: 46 },
        message_id: 1,
        voice: { file_id: "voice-1" },
      } as never,
      options: undefined,
      primaryCtx: {
        me: { id: 7, username: "bot" },
      } as never,
      requireMention: true,
      routeAgentId: undefined,
      senderId: "46",
      senderUsername: "",
      topicConfig: undefined,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { chatId: -1_001_234_567_890, reason: "no-mention" },
      "skipping group message",
    );
    expect(result).toBeNull();
  });

  it("still transcribes when commands.useAccessGroups is false", async () => {
    transcribeFirstAudioMock.mockReset();
    transcribeFirstAudioMock.mockResolvedValueOnce("hey bot please help");

    const result = await resolveTelegramInboundBody({
      allMedia: [{ contentType: "audio/ogg", path: "/tmp/voice-2.ogg" }],
      cfg: {
        channels: { telegram: {} },
        commands: { useAccessGroups: false },
        messages: { groupChat: { mentionPatterns: [String.raw`\bbot\b`] } },
        tools: { media: { audio: { enabled: true } } },
      } as never,
      chatId: -1_001_234_567_891,
      effectiveDmAllow: normalizeAllowFrom([]),
      effectiveGroupAllow: normalizeAllowFrom(["999"]),
      groupConfig: { requireMention: true } as never,
      groupHistories: new Map(),
      historyLimit: 0,
      isGroup: true,
      logger: { info: vi.fn() },
      msg: {
        chat: { id: -1001234567891, title: "Test Group", type: "supergroup" },
        date: 1_700_000_001,
        entities: [],
        from: { first_name: "Eve", id: 46 },
        message_id: 2,
        voice: { file_id: "voice-2" },
      } as never,
      options: undefined,
      primaryCtx: {
        me: { id: 7, username: "bot" },
      } as never,
      requireMention: true,
      routeAgentId: undefined,
      senderId: "46",
      senderUsername: "",
      topicConfig: undefined,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      bodyText: "hey bot please help",
      effectiveWasMentioned: true,
    });
  });

  it("transcribes DM voice notes via preflight (not only groups)", async () => {
    transcribeFirstAudioMock.mockReset();
    transcribeFirstAudioMock.mockResolvedValueOnce("hello from a voice note");

    const result = await resolveTelegramInboundBody({
      allMedia: [{ contentType: "audio/ogg", path: "/tmp/voice-dm.ogg" }],
      cfg: {
        channels: { telegram: {} },
        tools: { media: { audio: { enabled: true } } },
      } as never,
      chatId: 42,
      effectiveDmAllow: normalizeAllowFrom([]),
      effectiveGroupAllow: normalizeAllowFrom([]),
      groupConfig: undefined,
      groupHistories: new Map(),
      historyLimit: 0,
      isGroup: false,
      logger: { info: vi.fn() },
      msg: {
        chat: { first_name: "Pat", id: 42, type: "private" },
        date: 1_700_000_010,
        entities: [],
        from: { first_name: "Pat", id: 42 },
        message_id: 10,
        voice: { file_id: "voice-dm-1" },
      } as never,
      options: undefined,
      primaryCtx: {
        me: { id: 7, username: "bot" },
      } as never,
      requireMention: false,
      routeAgentId: undefined,
      senderId: "42",
      senderUsername: "",
      topicConfig: undefined,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      bodyText: "hello from a voice note",
    });
    expect(result?.bodyText).not.toContain("<media:audio>");
  });
});
