import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TALK_TEST_PROVIDER_ID } from "../test-utils/talk-test-provider.js";
import { createConfigIO } from "./io.js";
import { buildTalkConfigResponse, normalizeTalkSection } from "./talk.js";

async function withTempConfig(
  config: unknown,
  run: (configPath: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-"));
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  try {
    await run(configPath);
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
}

describe("talk normalization", () => {
  it("keeps core Talk normalization generic and ignores legacy provider-flat fields", () => {
    const normalized = normalizeTalkSection({
      voiceId: "voice-123",
      voiceAliases: { Clawd: "VoiceAlias1234567890" },
      modelId: "eleven_v3",
      outputFormat: "pcm_44100",
      apiKey: "secret-key", // Pragma: allowlist secret
      interruptOnSpeech: false,
      silenceTimeoutMs: 1500,
    } as unknown as never);

    expect(normalized).toEqual({
      interruptOnSpeech: false,
      silenceTimeoutMs: 1500,
    });
  });

  it("uses new provider/providers shape directly when present", () => {
    const normalized = normalizeTalkSection({
      interruptOnSpeech: true,
      provider: "acme",
      providers: {
        acme: {
          custom: true,
          voiceId: "acme-voice",
        },
      },
    });

    expect(normalized).toEqual({
      interruptOnSpeech: true,
      provider: "acme",
      providers: {
        acme: {
          custom: true,
          voiceId: "acme-voice",
        },
      },
    });
  });

  it("merges duplicate provider ids after trimming", () => {
    const normalized = normalizeTalkSection({
      provider: " elevenlabs ",
      providers: {
        " elevenlabs ": {
          voiceId: "voice-123",
        },
        elevenlabs: {
          apiKey: "secret-key",
        },
      },
    });

    expect(normalized).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          apiKey: "secret-key",
          voiceId: "voice-123",
        },
      },
    });
  });

  it("builds a canonical resolved talk payload for clients", () => {
    const payload = buildTalkConfigResponse({
      interruptOnSpeech: true,
      provider: "acme",
      providers: {
        acme: {
          modelId: "acme-model",
          voiceId: "acme-voice",
        },
      },
    });

    expect(payload).toEqual({
      interruptOnSpeech: true,
      provider: "acme",
      providers: {
        acme: {
          modelId: "acme-model",
          voiceId: "acme-voice",
        },
      },
      resolved: {
        config: {
          modelId: "acme-model",
          voiceId: "acme-voice",
        },
        provider: "acme",
      },
    });
  });

  it("preserves SecretRef apiKey values during normalization", () => {
    const normalized = normalizeTalkSection({
      provider: TALK_TEST_PROVIDER_ID,
      providers: {
        [TALK_TEST_PROVIDER_ID]: {
          apiKey: { id: "ELEVENLABS_API_KEY", provider: "default", source: "env" },
        },
      },
    });

    expect(normalized).toEqual({
      provider: TALK_TEST_PROVIDER_ID,
      providers: {
        [TALK_TEST_PROVIDER_ID]: {
          apiKey: { id: "ELEVENLABS_API_KEY", provider: "default", source: "env" },
        },
      },
    });
  });

  it("does not inject provider apiKey defaults during snapshot materialization", async () => {
    await withTempConfig(
      {
        talk: {
          voiceId: "voice-123",
        },
      },
      async (configPath) => {
        const io = createConfigIO({ configPath });
        const snapshot = await io.readConfigFileSnapshot();
        expect(snapshot.config.talk?.provider).toBeUndefined();
        expect(snapshot.config.talk?.providers?.elevenlabs?.voiceId).toBe("voice-123");
        expect(snapshot.config.talk?.providers?.elevenlabs?.apiKey).toBeUndefined();
      },
    );
  });
});
