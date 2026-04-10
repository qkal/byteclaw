import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { MIN_AUDIO_FILE_BYTES } from "./defaults.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import type { AudioTranscriptionRequest } from "./types.js";

const modelAuthMocks = vi.hoisted(() => ({
  hasAvailableAuthForProvider: vi.fn(() => true),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? "test-key"),
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "test-key",
    mode: "api-key",
    source: "test",
  })),
}));

vi.mock("../agents/model-auth.js", () => ({
  hasAvailableAuthForProvider: modelAuthMocks.hasAvailableAuthForProvider,
  requireApiKey: modelAuthMocks.requireApiKey,
  resolveApiKeyForProvider: modelAuthMocks.resolveApiKeyForProvider,
}));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

async function withAudioFixture(params: {
  filePrefix: string;
  extension: string;
  mediaType: string;
  fileContents: Buffer;
  run: (params: {
    ctx: MsgContext;
    media: ReturnType<typeof normalizeMediaAttachments>;
    cache: ReturnType<typeof createMediaAttachmentCache>;
  }) => Promise<void>;
}) {
  const originalPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";

  const tmpPath = path.join(
    os.tmpdir(),
    `${params.filePrefix}-${Date.now().toString()}.${params.extension}`,
  );
  await fs.writeFile(tmpPath, params.fileContents);

  const ctx: MsgContext = { MediaPath: tmpPath, MediaType: params.mediaType };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media, {
    includeDefaultLocalPathRoots: false,
    localPathRoots: [path.dirname(tmpPath)],
  });

  try {
    await params.run({ cache, ctx, media });
  } finally {
    process.env.PATH = originalPath;
    await cache.cleanup();
    await fs.unlink(tmpPath).catch(() => {});
  }
}

const AUDIO_CAPABILITY_CFG = {
  models: {
    providers: {
      openai: {
        apiKey: "test-key", // Pragma: allowlist secret
        models: [],
      },
    },
  },
} as unknown as OpenClawConfig;

async function runAudioCapabilityWithTranscriber(params: {
  ctx: MsgContext;
  media: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
  transcribeAudio: (req: AudioTranscriptionRequest) => Promise<{ text: string; model: string }>;
}) {
  const providerRegistry = buildProviderRegistry({
    openai: {
      capabilities: ["audio"],
      id: "openai",
      transcribeAudio: params.transcribeAudio,
    },
  });

  return await runCapability({
    attachments: params.cache,
    capability: "audio",
    cfg: AUDIO_CAPABILITY_CFG,
    ctx: params.ctx,
    media: params.media,
    providerRegistry,
  });
}

describe("runCapability skips tiny audio files", () => {
  it("skips audio transcription when file is smaller than MIN_AUDIO_FILE_BYTES", async () => {
    await withAudioFixture({
      filePrefix: "openclaw-tiny-audio",
      extension: "wav",
      mediaType: "audio/wav",
      fileContents: Buffer.alloc(100), // 100 bytes, way below 1024
      run: async ({ ctx, media, cache }) => {
        let transcribeCalled = false;
        const result = await runAudioCapabilityWithTranscriber({
          cache,
          ctx,
          media,
          transcribeAudio: async (req) => {
            transcribeCalled = true;
            return { model: req.model ?? "whisper-1", text: "should not happen" };
          },
        });

        // The provider should never be called
        expect(transcribeCalled).toBe(false);

        // The result should indicate the attachment was skipped
        expect(result.outputs).toHaveLength(0);
        expect(result.decision.outcome).toBe("skipped");
        expect(result.decision.attachments).toHaveLength(1);
        expect(result.decision.attachments[0].attempts).toHaveLength(1);
        expect(result.decision.attachments[0].attempts[0].outcome).toBe("skipped");
        expect(result.decision.attachments[0].attempts[0].reason).toContain("tooSmall");
      },
    });
  });

  it("skips audio transcription for empty (0-byte) files", async () => {
    await withAudioFixture({
      extension: "ogg",
      fileContents: Buffer.alloc(0),
      filePrefix: "openclaw-empty-audio",
      mediaType: "audio/ogg",
      run: async ({ ctx, media, cache }) => {
        let transcribeCalled = false;
        const result = await runAudioCapabilityWithTranscriber({
          cache,
          ctx,
          media,
          transcribeAudio: async () => {
            transcribeCalled = true;
            return { text: "nope", model: "whisper-1" };
          },
        });

        expect(transcribeCalled).toBe(false);
        expect(result.outputs).toHaveLength(0);
      },
    });
  });

  it("proceeds with transcription when file meets minimum size", async () => {
    await withAudioFixture({
      extension: "wav",
      fileContents: Buffer.alloc(MIN_AUDIO_FILE_BYTES + 100),
      filePrefix: "openclaw-ok-audio",
      mediaType: "audio/wav",
      run: async ({ ctx, media, cache }) => {
        let transcribeCalled = false;
        const result = await runAudioCapabilityWithTranscriber({
          cache,
          ctx,
          media,
          transcribeAudio: async (req) => {
            transcribeCalled = true;
            return { text: "hello world", model: req.model ?? "whisper-1" };
          },
        });

        expect(transcribeCalled).toBe(true);
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0].text).toBe("hello world");
        expect(result.decision.outcome).toBe("success");
      },
    });
  });
});
