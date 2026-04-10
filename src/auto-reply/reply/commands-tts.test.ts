import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const ttsMocks = vi.hoisted(() => ({
  getLastTtsAttempt: vi.fn(),
  getResolvedSpeechProviderConfig: vi.fn(),
  getTtsMaxLength: vi.fn(),
  getTtsProvider: vi.fn(),
  isSummarizationEnabled: vi.fn(),
  isTtsEnabled: vi.fn(),
  isTtsProviderConfigured: vi.fn(),
  resolveTtsConfig: vi.fn(),
  resolveTtsPrefsPath: vi.fn(),
  setLastTtsAttempt: vi.fn(),
  setSummarizationEnabled: vi.fn(),
  setTtsEnabled: vi.fn(),
  setTtsMaxLength: vi.fn(),
  setTtsProvider: vi.fn(),
  textToSpeech: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn((provider: string) => provider),
  getSpeechProvider: vi.fn(() => null),
  listSpeechProviders: vi.fn(() => []),
}));

vi.mock("../../tts/tts.js", () => ttsMocks);

const { handleTtsCommands } = await import("./commands-tts.js");
const PRIMARY_TTS_PROVIDER = "acme-speech";
const FALLBACK_TTS_PROVIDER = "backup-speech";

function buildTtsParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = {},
): Parameters<typeof handleTtsCommands>[0] {
  return {
    cfg,
    command: {
      channel: "telegram",
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: "owner",
    },
  } as unknown as Parameters<typeof handleTtsCommands>[0];
}

describe("handleTtsCommands status fallback reporting", () => {
  beforeEach(() => {
    ttsMocks.resolveTtsConfig.mockReturnValue({});
    ttsMocks.resolveTtsPrefsPath.mockReturnValue("/tmp/tts-prefs.json");
    ttsMocks.isTtsEnabled.mockReturnValue(true);
    ttsMocks.getTtsProvider.mockReturnValue(PRIMARY_TTS_PROVIDER);
    ttsMocks.isTtsProviderConfigured.mockReturnValue(true);
    ttsMocks.getTtsMaxLength.mockReturnValue(1500);
    ttsMocks.isSummarizationEnabled.mockReturnValue(true);
    ttsMocks.getLastTtsAttempt.mockReturnValue(undefined);
  });

  it("shows fallback provider details for successful attempts", async () => {
    ttsMocks.getLastTtsAttempt.mockReturnValue({
      attemptedProviders: [PRIMARY_TTS_PROVIDER, FALLBACK_TTS_PROVIDER],
      attempts: [
        {
          latencyMs: 73,
          outcome: "failed",
          provider: PRIMARY_TTS_PROVIDER,
          reasonCode: "provider_error",
        },
        {
          latencyMs: 420,
          outcome: "success",
          provider: FALLBACK_TTS_PROVIDER,
          reasonCode: "success",
        },
      ],
      fallbackFrom: PRIMARY_TTS_PROVIDER,
      latencyMs: 420,
      provider: FALLBACK_TTS_PROVIDER,
      success: true,
      summarized: false,
      textLength: 128,
      timestamp: Date.now() - 1000,
    });

    const result = await handleTtsCommands(buildTtsParams("/tts status"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain(
      `Fallback: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(result?.reply?.text).toContain(
      `Attempts: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(result?.reply?.text).toContain(
      `Attempt details: ${PRIMARY_TTS_PROVIDER}:failed(provider_error) 73ms, ${FALLBACK_TTS_PROVIDER}:success(ok) 420ms`,
    );
  });

  it("shows attempted provider chain for failed attempts", async () => {
    ttsMocks.getLastTtsAttempt.mockReturnValue({
      attemptedProviders: [PRIMARY_TTS_PROVIDER, FALLBACK_TTS_PROVIDER],
      attempts: [
        {
          latencyMs: 999,
          outcome: "failed",
          provider: PRIMARY_TTS_PROVIDER,
          reasonCode: "timeout",
        },
      ],
      error: "TTS conversion failed",
      latencyMs: 420,
      success: false,
      summarized: false,
      textLength: 128,
      timestamp: Date.now() - 1000,
    });

    const result = await handleTtsCommands(buildTtsParams("/tts status"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Error: TTS conversion failed");
    expect(result?.reply?.text).toContain(
      `Attempts: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(result?.reply?.text).toContain(
      `Attempt details: ${PRIMARY_TTS_PROVIDER}:failed(timeout) 999ms`,
    );
  });

  it("persists fallback metadata from /tts audio and renders it in /tts status", async () => {
    let lastAttempt: Record<string, unknown> | undefined;
    ttsMocks.getLastTtsAttempt.mockImplementation(() => lastAttempt);
    ttsMocks.setLastTtsAttempt.mockImplementation((next: Record<string, unknown>) => {
      lastAttempt = next;
    });
    ttsMocks.textToSpeech.mockResolvedValue({
      attemptedProviders: [PRIMARY_TTS_PROVIDER, FALLBACK_TTS_PROVIDER],
      attempts: [
        {
          latencyMs: 65,
          outcome: "failed",
          provider: PRIMARY_TTS_PROVIDER,
          reasonCode: "provider_error",
        },
        {
          latencyMs: 175,
          outcome: "success",
          provider: FALLBACK_TTS_PROVIDER,
          reasonCode: "success",
        },
      ],
      audioPath: "/tmp/fallback.ogg",
      fallbackFrom: PRIMARY_TTS_PROVIDER,
      latencyMs: 175,
      provider: FALLBACK_TTS_PROVIDER,
      success: true,
      voiceCompatible: true,
    });

    const audioResult = await handleTtsCommands(buildTtsParams("/tts audio hello world"), true);
    expect(audioResult?.shouldContinue).toBe(false);
    expect(audioResult?.reply?.mediaUrl).toBe("/tmp/fallback.ogg");

    const statusResult = await handleTtsCommands(buildTtsParams("/tts status"), true);
    expect(statusResult?.shouldContinue).toBe(false);
    expect(statusResult?.reply?.text).toContain(`Provider: ${FALLBACK_TTS_PROVIDER}`);
    expect(statusResult?.reply?.text).toContain(
      `Fallback: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(statusResult?.reply?.text).toContain(
      `Attempts: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(statusResult?.reply?.text).toContain(
      `Attempt details: ${PRIMARY_TTS_PROVIDER}:failed(provider_error) 65ms, ${FALLBACK_TTS_PROVIDER}:success(ok) 175ms`,
    );
  });

  it("treats bare /tts as status", async () => {
    const result = await handleTtsCommands(
      buildTtsParams("/tts", {
        messages: { tts: { prefsPath: "/tmp/tts.json" } },
      } as OpenClawConfig),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("TTS status");
  });
});
