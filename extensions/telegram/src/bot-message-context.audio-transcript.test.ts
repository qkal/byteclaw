import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioMock = vi.fn();
const DEFAULT_MODEL = "anthropic/claude-opus-4-5";
const DEFAULT_WORKSPACE = "/tmp/openclaw";
const DEFAULT_MENTION_PATTERN = String.raw`\bbot\b`;

vi.mock("./media-understanding.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");

async function buildGroupVoiceContext(params: {
  messageId: number;
  chatId: number;
  title: string;
  date: number;
  fromId: number;
  firstName: string;
  fileId: string;
  mediaPath: string;
  groupDisableAudioPreflight?: boolean;
  topicDisableAudioPreflight?: boolean;
}) {
  const groupConfig = {
    requireMention: true,
    ...(params.groupDisableAudioPreflight === undefined
      ? {}
      : { disableAudioPreflight: params.groupDisableAudioPreflight }),
  };
  const topicConfig =
    params.topicDisableAudioPreflight === undefined
      ? undefined
      : { disableAudioPreflight: params.topicDisableAudioPreflight };

  return buildTelegramMessageContextForTest({
    allMedia: [{ contentType: "audio/ogg", path: params.mediaPath }],
    cfg: {
      agents: { defaults: { model: DEFAULT_MODEL, workspace: DEFAULT_WORKSPACE } },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [DEFAULT_MENTION_PATTERN] } },
    },
    message: {
      chat: { id: params.chatId, title: params.title, type: "supergroup" },
      date: params.date,
      from: { first_name: params.firstName, id: params.fromId },
      message_id: params.messageId,
      text: undefined,
      voice: { file_id: params.fileId },
    },
    options: { forceWasMentioned: true },
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => true,
    resolveTelegramGroupConfig: () => ({
      groupConfig,
      topicConfig,
    }),
  });
}

function expectTranscriptRendered(
  ctx: Awaited<ReturnType<typeof buildGroupVoiceContext>>,
  transcript: string,
) {
  expect(ctx).not.toBeNull();
  expect(ctx?.ctxPayload?.BodyForAgent).toBe(transcript);
  expect(ctx?.ctxPayload?.Body).toContain(transcript);
  expect(ctx?.ctxPayload?.Body).not.toContain("<media:audio>");
}

function expectAudioPlaceholderRendered(ctx: Awaited<ReturnType<typeof buildGroupVoiceContext>>) {
  expect(ctx).not.toBeNull();
  expect(ctx?.ctxPayload?.Body).toContain("<media:audio>");
}

describe("buildTelegramMessageContext audio transcript body", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
  });

  it("uses preflight transcript as BodyForAgent for mention-gated group voice messages", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("hey bot please help");

    const ctx = await buildGroupVoiceContext({
      chatId: -1_001_234_567_890,
      date: 1_700_000_000,
      fileId: "voice-1",
      firstName: "Alice",
      fromId: 42,
      mediaPath: "/tmp/voice.ogg",
      messageId: 1,
      title: "Test Group",
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectTranscriptRendered(ctx, "hey bot please help");
  });

  it("skips preflight transcription when disableAudioPreflight is true", async () => {
    transcribeFirstAudioMock.mockClear();

    const ctx = await buildGroupVoiceContext({
      chatId: -1_001_234_567_891,
      date: 1_700_000_100,
      fileId: "voice-2",
      firstName: "Bob",
      fromId: 43,
      groupDisableAudioPreflight: true,
      mediaPath: "/tmp/voice2.ogg",
      messageId: 2,
      title: "Test Group 2",
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expectAudioPlaceholderRendered(ctx);
  });

  it("uses topic disableAudioPreflight=false to override group disableAudioPreflight=true", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("topic override transcript");

    const ctx = await buildGroupVoiceContext({
      chatId: -1_001_234_567_892,
      date: 1_700_000_200,
      fileId: "voice-3",
      firstName: "Cara",
      fromId: 44,
      groupDisableAudioPreflight: true,
      mediaPath: "/tmp/voice3.ogg",
      messageId: 3,
      title: "Test Group 3",
      topicDisableAudioPreflight: false,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectTranscriptRendered(ctx, "topic override transcript");
  });

  it("uses topic disableAudioPreflight=true to override group disableAudioPreflight=false", async () => {
    transcribeFirstAudioMock.mockClear();

    const ctx = await buildGroupVoiceContext({
      chatId: -1_001_234_567_893,
      date: 1_700_000_300,
      fileId: "voice-4",
      firstName: "Dan",
      fromId: 45,
      groupDisableAudioPreflight: false,
      mediaPath: "/tmp/voice4.ogg",
      messageId: 4,
      title: "Test Group 4",
      topicDisableAudioPreflight: true,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expectAudioPlaceholderRendered(ctx);
  });
});
