import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest, MediaUnderstandingProvider } from "./types.js";

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

function createProviderRegistry(
  providers: Record<string, MediaUnderstandingProvider>,
): Map<string, MediaUnderstandingProvider> {
  // Keep these tests focused on auto-entry selection instead of paying the full
  // Plugin capability registry build for every stub provider setup.
  return new Map(Object.entries(providers));
}

function createOpenAiAudioProvider(
  transcribeAudio: (req: AudioTranscriptionRequest) => Promise<{ text: string; model: string }>,
) {
  return createProviderRegistry({
    openai: {
      capabilities: ["audio"],
      id: "openai",
      transcribeAudio,
    },
  });
}

function createOpenAiAudioCfg(extra?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test-key",
          models: [],
        },
      },
    },
    ...extra,
  } as unknown as OpenClawConfig;
}

async function runAutoAudioCase(params: {
  transcribeAudio: (req: AudioTranscriptionRequest) => Promise<{ text: string; model: string }>;
  cfgExtra?: Partial<OpenClawConfig>;
}) {
  let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
  await withAudioFixture("openclaw-auto-audio", async ({ ctx, media, cache }) => {
    const providerRegistry = createOpenAiAudioProvider(params.transcribeAudio);
    const cfg = createOpenAiAudioCfg(params.cfgExtra);
    runResult = await runCapability({
      attachments: cache,
      capability: "audio",
      cfg,
      ctx,
      media,
      providerRegistry,
    });
  });
  if (!runResult) {
    throw new Error("Expected auto audio case result");
  }
  return runResult;
}

describe("runCapability auto audio entries", () => {
  it("uses provider keys to auto-enable audio transcription", async () => {
    let seenModel: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenModel = req.model;
        return { model: req.model ?? "unknown", text: "ok" };
      },
    });
    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenModel).toBe("gpt-4o-transcribe");
    expect(result.decision.outcome).toBe("success");
  });

  it("skips auto audio when disabled", async () => {
    const result = await runAutoAudioCase({
      cfgExtra: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      },
      transcribeAudio: async () => ({
        model: "whisper-1",
        text: "ok",
      }),
    });
    expect(result.outputs).toHaveLength(0);
    expect(result.decision.outcome).toBe("disabled");
  });

  it("prefers explicitly configured audio model entries", async () => {
    let seenModel: string | undefined;
    const result = await runAutoAudioCase({
      cfgExtra: {
        tools: {
          media: {
            audio: {
              models: [{ model: "whisper-1", provider: "openai" }],
            },
          },
        },
      },
      transcribeAudio: async (req) => {
        seenModel = req.model;
        return { model: req.model ?? "unknown", text: "ok" };
      },
    });

    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenModel).toBe("whisper-1");
  });

  it("lets per-request transcription hints override configured model-entry hints", async () => {
    let seenLanguage: string | undefined;
    let seenPrompt: string | undefined;
    const result = await runAutoAudioCase({
      cfgExtra: {
        tools: {
          media: {
            audio: {
              _requestLanguageOverride: "en",
              _requestPromptOverride: "Focus on names",
              enabled: true,
              language: "fr",
              models: [
                {
                  provider: "openai",
                  model: "whisper-1",
                  prompt: "entry prompt",
                  language: "de",
                },
              ],
              prompt: "configured prompt",
            },
          },
        },
      } as Partial<OpenClawConfig>,
      transcribeAudio: async (req) => {
        seenLanguage = req.language;
        seenPrompt = req.prompt;
        return { model: req.model ?? "unknown", text: "ok" };
      },
    });

    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenLanguage).toBe("en");
    expect(seenPrompt).toBe("Focus on names");
  });

  it("uses mistral when only mistral key is configured", async () => {
    const isolatedAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-agent-"));
    let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
    try {
      await withEnvAsync(
        {
          OPENAI_API_KEY: undefined,
          GROQ_API_KEY: undefined,
          DEEPGRAM_API_KEY: undefined,
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
          MISTRAL_API_KEY: "mistral-test-key", // Pragma: allowlist secret
          OPENCLAW_AGENT_DIR: isolatedAgentDir,
          PI_CODING_AGENT_DIR: isolatedAgentDir,
        },
        async () => {
          await withAudioFixture("openclaw-auto-audio-mistral", async ({ ctx, media, cache }) => {
            const providerRegistry = createProviderRegistry({
              mistral: {
                capabilities: ["audio"],
                id: "mistral",
                transcribeAudio: async (req) => ({
                  model: req.model ?? "unknown",
                  text: "mistral",
                }),
              },
              openai: {
                capabilities: ["audio"],
                id: "openai",
                transcribeAudio: async () => ({
                  model: "gpt-4o-transcribe",
                  text: "openai",
                }),
              },
            });
            const cfg = {
              models: {
                providers: {
                  mistral: {
                    apiKey: "mistral-test-key", // Pragma: allowlist secret
                    models: [],
                  },
                },
              },
              tools: {
                media: {
                  audio: {
                    enabled: true,
                  },
                },
              },
            } as unknown as OpenClawConfig;

            runResult = await runCapability({
              attachments: cache,
              capability: "audio",
              cfg,
              ctx,
              media,
              providerRegistry,
            });
          });
        },
      );
    } finally {
      await fs.rm(isolatedAgentDir, { force: true, recursive: true });
    }
    if (!runResult) {
      throw new Error("Expected auto audio mistral result");
    }
    expect(runResult.decision.outcome).toBe("success");
    expect(runResult.outputs[0]?.provider).toBe("mistral");
    expect(runResult.outputs[0]?.model).toBe("voxtral-mini-latest");
    expect(runResult.outputs[0]?.text).toBe("mistral");
  });
});
