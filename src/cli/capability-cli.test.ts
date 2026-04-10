import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerCapabilityCli } from "./capability-cli.js";

const mocks = vi.hoisted(() => ({
  agentCommand: vi.fn(async () => ({
    meta: { agentMeta: { model: "gpt-5.4", provider: "openai" } },
    payloads: [{ text: "local reply" }],
  })),
  callGateway: vi.fn(async ({ method }: { method: string }) => {
    if (method === "tts.status") {
      return { enabled: true, provider: "openai" };
    }
    if (method === "agent") {
      return {
        result: {
          meta: { agentMeta: { model: "claude-sonnet-4-6", provider: "anthropic" } },
          payloads: [{ text: "gateway reply" }],
        },
      };
    }
    return {};
  }),
  createEmbeddingProvider: vi.fn(async () => ({
    provider: {
      embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
      embedQuery: async () => [0.1, 0.2],
      id: "openai",
      model: "text-embedding-3-small",
    },
  })),
  describeImageFile: vi.fn(async () => ({
    model: "gpt-4.1-mini",
    provider: "openai",
    text: "friendly lobster",
  })),
  generateImage: vi.fn(),
  isWebFetchProviderConfigured: vi.fn(() => false),
  isWebSearchProviderConfigured: vi.fn(() => false),
  listMemoryEmbeddingProviders: vi.fn(() => [
    { defaultModel: "text-embedding-3-small", id: "openai", transport: "remote" },
  ]),
  listProfilesForProvider: vi.fn(() => []),
  loadAuthProfileStoreForRuntime: vi.fn(() => ({ order: {}, profiles: {} })),
  loadConfig: vi.fn(() => ({})),
  loadModelCatalog: vi.fn(async () => []),
  modelsStatusCommand: vi.fn(
    async (_opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
      runtime.log(JSON.stringify({ ok: true, providers: [{ id: "openai" }] }));
    },
  ),
  registerBuiltInMemoryEmbeddingProviders: vi.fn(),
  registerMemoryEmbeddingProvider: vi.fn(),
  resolveExplicitTtsOverrides: vi.fn(
    ({
      provider,
      modelId,
      voiceId,
    }: {
      provider?: string;
      modelId?: string;
      voiceId?: string;
    }) => ({
      ...(provider ? { provider } : {}),
      ...(modelId || voiceId
        ? {
            providerOverrides: {
              [provider ?? "openai"]: {
                ...(modelId ? { modelId } : {}),
                ...(voiceId ? { voiceId } : {}),
              },
            },
          }
        : {}),
    }),
  ),
  resolveMemorySearchConfig: vi.fn(() => null),
  runtime: {
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    log: vi.fn(),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
  setTtsProvider: vi.fn(),
  textToSpeech: vi.fn(async () => ({
    attempts: [],
    audioPath: "/tmp/tts-source.mp3",
    outputFormat: "mp3",
    provider: "openai",
    success: true,
    voiceCompatible: false,
  })),
  transcribeAudioFile: vi.fn(async () => ({ text: "meeting notes" })),
  updateAuthProfileStoreWithLock: vi.fn(
    async ({ updater }: { updater: (store: any) => boolean }) => {
      const store = {
        lastGood: {},
        order: {},
        profiles: {},
        usageStats: {},
        version: 1,
      };
      updater(store);
      return store;
    },
  ),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: { writeJson: (value: unknown) => void }, value: unknown) =>
    runtime.writeJson(value),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig as typeof import("../config/config.js").loadConfig,
}));

vi.mock("../agents/agent-command.js", () => ({
  agentCommand:
    mocks.agentCommand as unknown as typeof import("../agents/agent-command.js").agentCommand,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentDir: () => "/tmp/agent",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog:
    mocks.loadModelCatalog as typeof import("../agents/model-catalog.js").loadModelCatalog,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  listProfilesForProvider:
    mocks.listProfilesForProvider as typeof import("../agents/auth-profiles.js").listProfilesForProvider,
  loadAuthProfileStoreForRuntime:
    mocks.loadAuthProfileStoreForRuntime as unknown as typeof import("../agents/auth-profiles.js").loadAuthProfileStoreForRuntime,
}));

vi.mock("../agents/auth-profiles/store.js", () => ({
  updateAuthProfileStoreWithLock:
    mocks.updateAuthProfileStoreWithLock as typeof import("../agents/auth-profiles/store.js").updateAuthProfileStoreWithLock,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig:
    mocks.resolveMemorySearchConfig as typeof import("../agents/memory-search.js").resolveMemorySearchConfig,
}));

vi.mock("../commands/models.js", () => ({
  modelsAuthLoginCommand: vi.fn(),
  modelsStatusCommand:
    mocks.modelsStatusCommand as typeof import("../commands/models.js").modelsStatusCommand,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway as typeof import("../gateway/call.js").callGateway,
  randomIdempotencyKey: () => "run-1",
}));

vi.mock("../gateway/connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: vi.fn(() => ({
    message: "Gateway target: ws://127.0.0.1:18789",
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
  })),
}));

vi.mock("../media-understanding/runtime.js", () => ({
  describeImageFile:
    mocks.describeImageFile as typeof import("../media-understanding/runtime.js").describeImageFile,
  describeVideoFile: vi.fn(),
  transcribeAudioFile:
    mocks.transcribeAudioFile as typeof import("../media-understanding/runtime.js").transcribeAudioFile,
}));

vi.mock("../plugins/memory-embedding-providers.js", () => ({
  listMemoryEmbeddingProviders:
    mocks.listMemoryEmbeddingProviders as unknown as typeof import("../plugins/memory-embedding-providers.js").listMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider:
    mocks.registerMemoryEmbeddingProvider as unknown as typeof import("../plugins/memory-embedding-providers.js").registerMemoryEmbeddingProvider,
}));

vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  createEmbeddingProvider:
    mocks.createEmbeddingProvider as unknown as typeof import("../plugin-sdk/memory-core-bundled-runtime.js").createEmbeddingProvider,
  registerBuiltInMemoryEmbeddingProviders:
    mocks.registerBuiltInMemoryEmbeddingProviders as typeof import("../plugin-sdk/memory-core-bundled-runtime.js").registerBuiltInMemoryEmbeddingProviders,
}));

vi.mock("../image-generation/runtime.js", () => ({
  generateImage: (...args: unknown[]) => mocks.generateImage(...args),
  listRuntimeImageGenerationProviders: vi.fn(() => []),
}));

vi.mock("../video-generation/runtime.js", () => ({
  generateVideo: vi.fn(),
  listRuntimeVideoGenerationProviders: vi.fn(() => []),
}));

vi.mock("../tts/tts.js", () => ({
  getTtsProvider: vi.fn(() => "openai"),
  listSpeechVoices: vi.fn(async () => []),
  resolveExplicitTtsOverrides:
    mocks.resolveExplicitTtsOverrides as typeof import("../tts/tts.js").resolveExplicitTtsOverrides,
  resolveTtsConfig: vi.fn(() => ({})),
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  setTtsEnabled: vi.fn(),
  setTtsProvider: mocks.setTtsProvider as typeof import("../tts/tts.js").setTtsProvider,
  textToSpeech: mocks.textToSpeech as typeof import("../tts/tts.js").textToSpeech,
}));

vi.mock("../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn((provider: string) => provider),
  listSpeechProviders: vi.fn(() => []),
}));

vi.mock("../web-search/runtime.js", () => ({
  isWebSearchProviderConfigured:
    mocks.isWebSearchProviderConfigured as typeof import("../web-search/runtime.js").isWebSearchProviderConfigured,
  listWebSearchProviders: vi.fn(() => []),
  runWebSearch: vi.fn(),
}));

vi.mock("../web-fetch/runtime.js", () => ({
  isWebFetchProviderConfigured:
    mocks.isWebFetchProviderConfigured as typeof import("../web-fetch/runtime.js").isWebFetchProviderConfigured,
  listWebFetchProviders: vi.fn(() => []),
  resolveWebFetchDefinition: vi.fn(),
}));

describe("capability cli", () => {
  beforeEach(() => {
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.loadModelCatalog
      .mockReset()
      .mockResolvedValue([{ id: "gpt-5.4", name: "GPT-5.4", provider: "openai" }] as never);
    mocks.loadAuthProfileStoreForRuntime.mockReset().mockReturnValue({ order: {}, profiles: {} });
    mocks.listProfilesForProvider.mockReset().mockReturnValue([]);
    mocks.updateAuthProfileStoreWithLock
      .mockReset()
      .mockImplementation(async ({ updater }: { updater: (store: any) => boolean }) => {
        const store = {
          lastGood: {},
          order: {},
          profiles: {},
          usageStats: {},
          version: 1,
        };
        updater(store);
        return store;
      });
    mocks.resolveMemorySearchConfig.mockReset().mockReturnValue(null);
    mocks.agentCommand.mockClear();
    mocks.callGateway.mockClear().mockImplementation((async ({ method }: { method: string }) => {
      if (method === "tts.status") {
        return { enabled: true, provider: "openai" };
      }
      if (method === "agent") {
        return {
          result: {
            meta: { agentMeta: { model: "claude-sonnet-4-6", provider: "anthropic" } },
            payloads: [{ text: "gateway reply" }],
          },
        };
      }
      return {};
    }) as never);
    mocks.describeImageFile.mockClear();
    mocks.generateImage.mockReset();
    mocks.transcribeAudioFile.mockClear();
    mocks.textToSpeech.mockClear();
    mocks.setTtsProvider.mockClear();
    mocks.resolveExplicitTtsOverrides.mockClear();
    mocks.createEmbeddingProvider.mockClear();
    mocks.registerMemoryEmbeddingProvider.mockClear();
    mocks.registerBuiltInMemoryEmbeddingProviders.mockClear();
    mocks.isWebSearchProviderConfigured.mockReset().mockReturnValue(false);
    mocks.isWebFetchProviderConfigured.mockReset().mockReturnValue(false);
    mocks.modelsStatusCommand.mockClear();
    mocks.callGateway.mockImplementation((async ({ method }: { method: string }) => {
      if (method === "tts.status") {
        return { enabled: true, provider: "openai" };
      }
      if (method === "tts.convert") {
        return {
          audioPath: "/tmp/gateway-tts.mp3",
          outputFormat: "mp3",
          provider: "openai",
          voiceCompatible: false,
        };
      }
      if (method === "agent") {
        return {
          result: {
            meta: { agentMeta: { model: "claude-sonnet-4-6", provider: "anthropic" } },
            payloads: [{ text: "gateway reply" }],
          },
        };
      }
      return {};
    }) as never);
  });

  it("lists canonical capabilities", async () => {
    await runRegisteredCli({
      argv: ["capability", "list", "--json"],
      register: registerCapabilityCli as (program: Command) => void,
    });

    const payload = mocks.runtime.writeJson.mock.calls[0]?.[0] as { id: string }[];
    expect(payload.some((entry) => entry.id === "model.run")).toBe(true);
    expect(payload.some((entry) => entry.id === "image.describe")).toBe(true);
  });

  it("defaults model run to local transport", async () => {
    await runRegisteredCli({
      argv: ["capability", "model", "run", "--prompt", "hello", "--json"],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "model.run",
        transport: "local",
      }),
    );
  });

  it("defaults tts status to gateway transport", async () => {
    await runRegisteredCli({
      argv: ["capability", "tts", "status", "--json"],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "tts.status" }),
    );
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ transport: "gateway" }),
    );
  });

  it("routes image describe through media understanding, not generation", async () => {
    await runRegisteredCli({
      argv: ["capability", "image", "describe", "--file", "photo.jpg", "--json"],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.describeImageFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: expect.stringMatching(/photo\.jpg$/) }),
    );
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "image.describe",
        outputs: [expect.objectContaining({ kind: "image.description" })],
      }),
    );
  });

  it("fails image describe when no description text is returned", async () => {
    mocks.describeImageFile.mockResolvedValueOnce({
      model: undefined,
      provider: undefined,
      text: undefined,
    } as never);

    await expect(
      runRegisteredCli({
        argv: ["capability", "image", "describe", "--file", "photo.jpg", "--json"],
        register: registerCapabilityCli as (program: Command) => void,
      }),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringMatching(/No description returned for image/),
    );
  });

  it("rewrites mismatched explicit image output extensions to the detected file type", async () => {
    const jpegBase64 =
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFRUVFRUVFRUVFRUVFRUVFRUXFhUVFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGhAQGi0fHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFhEBAQEAAAAAAAAAAAAAAAAAAAER/9oADAMBAAIQAxAAAAH2AP/EABgQAQEAAwAAAAAAAAAAAAAAAAEAEQIS/9oACAEBAAEFAk1o7//EABYRAQEBAAAAAAAAAAAAAAAAAAABEf/aAAgBAwEBPwGn/8QAFhEBAQEAAAAAAAAAAAAAAAAAABEB/9oACAECAQE/AYf/xAAaEAACAgMAAAAAAAAAAAAAAAABEQAhMUFh/9oACAEBAAY/AjK9cY2f/8QAGhABAQACAwAAAAAAAAAAAAAAAAERITFBUf/aAAgBAQABPyGQk7W5jVYkA//Z";
    mocks.generateImage.mockResolvedValue({
      attempts: [],
      images: [
        {
          buffer: Buffer.from(jpegBase64, "base64"),
          fileName: "provider-output.png",
          mimeType: "image/png",
        },
      ],
      model: "gpt-image-1",
      provider: "openai",
    });

    const tempOutput = path.join(os.tmpdir(), `openclaw-image-mismatch-${Date.now()}.png`);
    await fs.rm(tempOutput, { force: true });
    await fs.rm(tempOutput.replace(/\.png$/, ".jpg"), { force: true });

    await runRegisteredCli({
      argv: [
        "capability",
        "image",
        "generate",
        "--prompt",
        "friendly lobster",
        "--output",
        tempOutput,
        "--json",
      ],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            mimeType: "image/jpeg",
            path: tempOutput.replace(/\.png$/, ".jpg"),
          }),
        ],
      }),
    );
  });

  it("routes audio transcribe through transcription, not realtime", async () => {
    await runRegisteredCli({
      argv: ["capability", "audio", "transcribe", "--file", "memo.m4a", "--json"],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: expect.stringMatching(/memo\.m4a$/) }),
    );
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "audio.transcribe",
        outputs: [expect.objectContaining({ kind: "audio.transcription" })],
      }),
    );
  });

  it("fails audio transcribe when no transcript text is returned", async () => {
    mocks.transcribeAudioFile.mockResolvedValueOnce({ text: undefined } as never);

    await expect(
      runRegisteredCli({
        argv: ["capability", "audio", "transcribe", "--file", "memo.m4a", "--json"],
        register: registerCapabilityCli as (program: Command) => void,
      }),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringMatching(/No transcript returned for audio/),
    );
  });

  it("forwards transcription prompt and language hints", async () => {
    await runRegisteredCli({
      argv: [
        "capability",
        "audio",
        "transcribe",
        "--file",
        "memo.m4a",
        "--language",
        "en",
        "--prompt",
        "Focus on names",
        "--json",
      ],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: expect.stringMatching(/memo\.m4a$/),
        language: "en",
        prompt: "Focus on names",
      }),
    );
  });

  it("uses request-scoped TTS overrides without mutating prefs", async () => {
    await runRegisteredCli({
      argv: [
        "capability",
        "tts",
        "convert",
        "--text",
        "hello",
        "--model",
        "openai/gpt-4o-mini-tts",
        "--voice",
        "alloy",
        "--json",
      ],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.objectContaining({
          provider: "openai",
          providerOverrides: expect.objectContaining({
            openai: expect.objectContaining({
              modelId: "gpt-4o-mini-tts",
              voiceId: "alloy",
            }),
          }),
        }),
      }),
    );
    expect(mocks.setTtsProvider).not.toHaveBeenCalled();
  });

  it("disables TTS fallback when explicit provider or voice/model selection is requested", async () => {
    await runRegisteredCli({
      argv: [
        "capability",
        "tts",
        "convert",
        "--text",
        "hello",
        "--model",
        "openai/gpt-4o-mini-tts",
        "--voice",
        "alloy",
        "--json",
      ],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        disableFallback: true,
      }),
    );
  });

  it("does not infer and forward a local provider guess for gateway TTS overrides", async () => {
    await runRegisteredCli({
      argv: [
        "capability",
        "tts",
        "convert",
        "--gateway",
        "--text",
        "hello",
        "--voice",
        "alloy",
        "--json",
      ],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "tts.convert",
        params: expect.objectContaining({
          provider: undefined,
          voiceId: "alloy",
        }),
      }),
    );
  });

  it("fails clearly when gateway TTS output is requested against a remote gateway", async () => {
    const gatewayConnection = await import("../gateway/connection-details.js");
    vi.mocked(gatewayConnection.buildGatewayConnectionDetailsWithResolvers).mockReturnValueOnce({
      message: "Gateway target: wss://gateway.example.com",
      url: "wss://gateway.example.com",
      urlSource: "config gateway.remote.url",
    });

    await expect(
      runRegisteredCli({
        argv: [
          "capability",
          "tts",
          "convert",
          "--gateway",
          "--text",
          "hello",
          "--output",
          "hello.mp3",
          "--json",
        ],
        register: registerCapabilityCli as (program: Command) => void,
      }),
    ).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("--output is not supported for remote gateway TTS yet"),
    );
  });

  it("uses only embedding providers for embedding creation", async () => {
    await runRegisteredCli({
      argv: ["capability", "embedding", "create", "--text", "hello", "--json"],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.createEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        fallback: "none",
        provider: "auto",
      }),
    );
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "embedding.create",
        model: "text-embedding-3-small",
        provider: "openai",
      }),
    );
  });

  it("derives the embedding provider from a provider/model override", async () => {
    await runRegisteredCli({
      argv: [
        "capability",
        "embedding",
        "create",
        "--text",
        "hello",
        "--model",
        "openai/text-embedding-3-large",
        "--json",
      ],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.createEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        fallback: "none",
        model: "text-embedding-3-large",
        provider: "openai",
      }),
    );
  });

  it("cleans provider auth profiles and usage stats on logout", async () => {
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({
      lastGood: { openai: "openai:secondary" },
      order: { openai: ["openai:default", "openai:secondary"] },
      profiles: {
        "anthropic:default": { id: "anthropic:default" },
        "openai:default": { id: "openai:default" },
        "openai:secondary": { id: "openai:secondary" },
      },
      usageStats: {
        "anthropic:default": { errorCount: 3 },
        "openai:default": { errorCount: 2 },
        "openai:secondary": { errorCount: 1 },
      },
    } as never);
    mocks.listProfilesForProvider.mockReturnValue(["openai:default", "openai:secondary"] as never);

    let updatedStore: Record<string, any> | null = null;
    mocks.updateAuthProfileStoreWithLock.mockImplementationOnce(
      async ({ updater }: { updater: (store: any) => boolean }) => {
        const store = {
          lastGood: { openai: "openai:secondary" },
          order: { openai: ["openai:default", "openai:secondary"] },
          profiles: {
            "anthropic:default": { id: "anthropic:default" },
            "openai:default": { id: "openai:default" },
            "openai:secondary": { id: "openai:secondary" },
          },
          usageStats: {
            "anthropic:default": { errorCount: 3 },
            "openai:default": { errorCount: 2 },
            "openai:secondary": { errorCount: 1 },
          },
          version: 1,
        };
        updater(store);
        updatedStore = store;
        return store;
      },
    );

    await runRegisteredCli({
      argv: ["capability", "model", "auth", "logout", "--provider", "openai", "--json"],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(updatedStore).toMatchObject({
      lastGood: {},
      order: {},
      profiles: {
        "anthropic:default": { id: "anthropic:default" },
      },
      usageStats: {
        "anthropic:default": { errorCount: 3 },
      },
    });
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      provider: "openai",
      removedProfiles: ["openai:default", "openai:secondary"],
    });
  });

  it("fails logout if the auth store update does not complete", async () => {
    mocks.listProfilesForProvider.mockReturnValue(["openai:default"] as never);
    mocks.updateAuthProfileStoreWithLock.mockResolvedValueOnce(null as never);

    await expect(
      runRegisteredCli({
        argv: ["capability", "model", "auth", "logout", "--provider", "openai", "--json"],
        register: registerCapabilityCli as (program: Command) => void,
      }),
    ).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to remove saved auth profiles for provider openai."),
    );
  });

  it("rejects providerless audio model overrides", async () => {
    await expect(
      runRegisteredCli({
        argv: [
          "capability",
          "audio",
          "transcribe",
          "--file",
          "memo.m4a",
          "--model",
          "whisper-1",
          "--json",
        ],
        register: registerCapabilityCli as (program: Command) => void,
      }),
    ).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Model overrides must use the form <provider/model>."),
    );
    expect(mocks.transcribeAudioFile).not.toHaveBeenCalled();
  });

  it("rejects providerless image describe model overrides", async () => {
    await expect(
      runRegisteredCli({
        argv: [
          "capability",
          "image",
          "describe",
          "--file",
          "photo.jpg",
          "--model",
          "gpt-4.1-mini",
          "--json",
        ],
        register: registerCapabilityCli as (program: Command) => void,
      }),
    ).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Model overrides must use the form <provider/model>."),
    );
    expect(mocks.describeImageFile).not.toHaveBeenCalled();
  });

  it("rejects providerless video describe model overrides", async () => {
    const mediaRuntime = await import("../media-understanding/runtime.js");
    vi.mocked(mediaRuntime.describeVideoFile).mockResolvedValue({
      model: "gpt-4.1-mini",
      provider: "openai",
      text: "friendly lobster",
    } as never);

    await expect(
      runRegisteredCli({
        argv: [
          "capability",
          "video",
          "describe",
          "--file",
          "clip.mp4",
          "--model",
          "gpt-4.1-mini",
          "--json",
        ],
        register: registerCapabilityCli as (program: Command) => void,
      }),
    ).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Model overrides must use the form <provider/model>."),
    );
    expect(vi.mocked(mediaRuntime.describeVideoFile)).not.toHaveBeenCalled();
  });

  it("bootstraps built-in embedding providers when the registry is empty", async () => {
    mocks.listMemoryEmbeddingProviders.mockReturnValueOnce([]);

    await runRegisteredCli({
      argv: ["capability", "embedding", "providers", "--json"],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.registerBuiltInMemoryEmbeddingProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        registerMemoryEmbeddingProvider: expect.any(Function),
      }),
    );
  });

  it("surfaces available, configured, and selected for web providers", async () => {
    mocks.loadConfig.mockReturnValue({
      tools: {
        web: {
          fetch: { provider: "firecrawl" },
          search: { provider: "gemini" },
        },
      },
    });
    const webSearchRuntime = await import("../web-search/runtime.js");
    const webFetchRuntime = await import("../web-fetch/runtime.js");
    vi.mocked(webSearchRuntime.listWebSearchProviders).mockReturnValue([
      { envVars: ["BRAVE_API_KEY"], id: "brave" } as never,
      { envVars: ["GEMINI_API_KEY"], id: "gemini" } as never,
    ]);
    vi.mocked(webFetchRuntime.listWebFetchProviders).mockReturnValue([
      { envVars: ["FIRECRAWL_API_KEY"], id: "firecrawl" } as never,
    ]);
    mocks.isWebSearchProviderConfigured.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mocks.isWebFetchProviderConfigured.mockReturnValueOnce(true);

    await runRegisteredCli({
      argv: ["capability", "web", "providers", "--json"],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      fetch: [
        {
          available: true,
          configured: true,
          envVars: ["FIRECRAWL_API_KEY"],
          id: "firecrawl",
          selected: true,
        },
      ],
      search: [
        {
          available: true,
          configured: false,
          envVars: ["BRAVE_API_KEY"],
          id: "brave",
          selected: false,
        },
        {
          available: true,
          configured: true,
          envVars: ["GEMINI_API_KEY"],
          id: "gemini",
          selected: true,
        },
      ],
    });
  });

  it("surfaces selected and configured embedding provider state", async () => {
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveMemorySearchConfig.mockReturnValue({
      model: "gemini-embedding-001",
      provider: "gemini",
    } as never);
    mocks.listMemoryEmbeddingProviders.mockReturnValue([
      { defaultModel: "text-embedding-3-small", id: "openai", transport: "remote" },
      { defaultModel: "gemini-embedding-001", id: "gemini", transport: "remote" },
    ]);

    await runRegisteredCli({
      argv: ["capability", "embedding", "providers", "--json"],
      register: registerCapabilityCli as (program: Command) => void,
    });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith([
      {
        autoSelectPriority: undefined,
        available: true,
        configured: false,
        defaultModel: "text-embedding-3-small",
        id: "openai",
        selected: false,
        transport: "remote",
      },
      {
        autoSelectPriority: undefined,
        available: true,
        configured: true,
        defaultModel: "gemini-embedding-001",
        id: "gemini",
        selected: true,
        transport: "remote",
      },
    ]);
  });
});
