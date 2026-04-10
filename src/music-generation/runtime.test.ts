import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMediaGenerationRuntimeMocks,
  resetMusicGenerationRuntimeMocks,
} from "../../test/helpers/media-generation/runtime-module-mocks.js";
import type { OpenClawConfig } from "../config/config.js";
import { generateMusic, listRuntimeMusicGenerationProviders } from "./runtime.js";
import type { MusicGenerationProvider } from "./types.js";

const mocks = getMediaGenerationRuntimeMocks();

vi.mock("./model-ref.js", () => ({
  parseMusicGenerationModelRef: mocks.parseMusicGenerationModelRef,
}));

vi.mock("./provider-registry.js", () => ({
  getMusicGenerationProvider: mocks.getMusicGenerationProvider,
  listMusicGenerationProviders: mocks.listMusicGenerationProviders,
}));

describe("music-generation runtime", () => {
  beforeEach(() => {
    resetMusicGenerationRuntimeMocks();
  });

  it("generates tracks through the active music-generation provider", async () => {
    const authStore = { profiles: {}, version: 1 } as const;
    let seenAuthStore: unknown;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("music-plugin/track-v1");
    const provider: MusicGenerationProvider = {
      capabilities: {},
      async generateMusic(req: { authStore?: unknown }) {
        seenAuthStore = req.authStore;
        return {
          model: "track-v1",
          tracks: [
            {
              buffer: Buffer.from("mp3-bytes"),
              mimeType: "audio/mpeg",
              fileName: "sample.mp3",
            },
          ],
        };
      },
      id: "music-plugin",
    };
    mocks.getMusicGenerationProvider.mockReturnValue(provider);

    const result = await generateMusic({
      agentDir: "/tmp/agent",
      authStore,
      cfg: {
        agents: {
          defaults: {
            musicGenerationModel: { primary: "music-plugin/track-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "play a synth line",
    });

    expect(result.provider).toBe("music-plugin");
    expect(result.model).toBe("track-v1");
    expect(result.attempts).toEqual([]);
    expect(result.ignoredOverrides).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(result.tracks).toEqual([
      {
        buffer: Buffer.from("mp3-bytes"),
        fileName: "sample.mp3",
        mimeType: "audio/mpeg",
      },
    ]);
  });

  it("auto-detects and falls through to another configured music-generation provider by default", async () => {
    mocks.getMusicGenerationProvider.mockImplementation((providerId: string) => {
      if (providerId === "google") {
        return {
          capabilities: {},
          defaultModel: "lyria-3-clip-preview",
          async generateMusic() {
            throw new Error("Google music generation response missing audio data");
          },
          id: "google",
          isConfigured: () => true,
        };
      }
      if (providerId === "minimax") {
        return {
          capabilities: {},
          defaultModel: "music-2.5+",
          async generateMusic() {
            return {
              model: "music-2.5+",
              tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
            };
          },
          id: "minimax",
          isConfigured: () => true,
        };
      }
      return undefined;
    });
    mocks.listMusicGenerationProviders.mockReturnValue([
      {
        capabilities: {},
        defaultModel: "lyria-3-clip-preview",
        generateMusic: async () => ({ tracks: [] }),
        id: "google",
        isConfigured: () => true,
      },
      {
        capabilities: {},
        defaultModel: "music-2.5+",
        generateMusic: async () => ({ tracks: [] }),
        id: "minimax",
        isConfigured: () => true,
      },
    ]);

    const result = await generateMusic({
      cfg: {} as OpenClawConfig,
      prompt: "play a synth line",
    });

    expect(result.provider).toBe("minimax");
    expect(result.model).toBe("music-2.5+");
    expect(result.attempts).toEqual([
      {
        error: "Google music generation response missing audio data",
        model: "lyria-3-clip-preview",
        provider: "google",
      },
    ]);
  });

  it("lists runtime music-generation providers through the provider registry", () => {
    const providers: MusicGenerationProvider[] = [
      {
        capabilities: {
          generate: {
            supportsDuration: true,
          },
        },
        defaultModel: "track-v1",
        generateMusic: async () => ({
          tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
        }),
        id: "music-plugin",
        models: ["track-v1"],
      },
    ];
    mocks.listMusicGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeMusicGenerationProviders({ config: {} as OpenClawConfig })).toEqual(
      providers,
    );
    expect(mocks.listMusicGenerationProviders).toHaveBeenCalledWith({} as OpenClawConfig);
  });

  it("ignores unsupported optional overrides per provider and model", async () => {
    let seenRequest:
      | {
          lyrics?: string;
          instrumental?: boolean;
          durationSeconds?: number;
          format?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("google/lyria-3-clip-preview");
    mocks.getMusicGenerationProvider.mockReturnValue({
      capabilities: {
        generate: {
          supportedFormatsByModel: {
            "lyria-3-clip-preview": ["mp3"],
          },
          supportsFormat: true,
          supportsInstrumental: true,
          supportsLyrics: true,
        },
      },
      generateMusic: async (req) => {
        seenRequest = {
          durationSeconds: req.durationSeconds,
          format: req.format,
          instrumental: req.instrumental,
          lyrics: req.lyrics,
        };
        return {
          model: "lyria-3-clip-preview",
          tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
        };
      },
      id: "google",
    });

    const result = await generateMusic({
      cfg: {
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
          },
        },
      } as OpenClawConfig,
      durationSeconds: 30,
      format: "wav",
      instrumental: true,
      lyrics: "Hero crab in the neon tide",
      prompt: "energetic arcade anthem",
    });

    expect(seenRequest).toEqual({
      durationSeconds: undefined,
      format: undefined,
      instrumental: true,
      lyrics: "Hero crab in the neon tide",
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "durationSeconds", value: 30 },
      { key: "format", value: "wav" },
    ]);
  });

  it("uses mode-specific capabilities for edit requests", async () => {
    let seenRequest:
      | {
          lyrics?: string;
          instrumental?: boolean;
          durationSeconds?: number;
          format?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("google/lyria-3-pro-preview");
    mocks.getMusicGenerationProvider.mockReturnValue({
      capabilities: {
        edit: {
          enabled: true,
          maxInputImages: 1,
          supportsDuration: false,
          supportsFormat: false,
          supportsInstrumental: true,
          supportsLyrics: true,
        },
        generate: {
          supportedFormats: ["mp3"],
          supportsFormat: true,
          supportsInstrumental: false,
          supportsLyrics: false,
        },
      },
      generateMusic: async (req) => {
        seenRequest = {
          durationSeconds: req.durationSeconds,
          format: req.format,
          instrumental: req.instrumental,
          lyrics: req.lyrics,
        };
        return {
          model: "lyria-3-pro-preview",
          tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
        };
      },
      id: "google",
    });

    const result = await generateMusic({
      cfg: {
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-pro-preview" },
          },
        },
      } as OpenClawConfig,
      durationSeconds: 30,
      format: "mp3",
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
      instrumental: true,
      lyrics: "rise up",
      prompt: "turn this cover image into a trailer cue",
    });

    expect(seenRequest).toEqual({
      durationSeconds: undefined,
      format: undefined,
      instrumental: true,
      lyrics: "rise up",
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "durationSeconds", value: 30 },
      { key: "format", value: "mp3" },
    ]);
  });

  it("normalizes requested durations to the closest supported max duration", async () => {
    let seenRequest:
      | {
          durationSeconds?: number;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("minimax/music-2.5+");
    mocks.getMusicGenerationProvider.mockReturnValue({
      capabilities: {
        generate: {
          maxDurationSeconds: 30,
          supportsDuration: true,
        },
      },
      generateMusic: async (req) => {
        seenRequest = {
          durationSeconds: req.durationSeconds,
        };
        return {
          model: "music-2.5+",
          tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
        };
      },
      id: "minimax",
    });

    const result = await generateMusic({
      cfg: {
        agents: {
          defaults: {
            musicGenerationModel: { primary: "minimax/music-2.5+" },
          },
        },
      } as OpenClawConfig,
      durationSeconds: 45,
      prompt: "energetic arcade anthem",
    });

    expect(seenRequest).toEqual({
      durationSeconds: 30,
    });
    expect(result.ignoredOverrides).toEqual([]);
    expect(result.normalization).toMatchObject({
      durationSeconds: {
        applied: 30,
        requested: 45,
      },
    });
    expect(result.metadata).toMatchObject({
      normalizedDurationSeconds: 30,
      requestedDurationSeconds: 45,
    });
  });
});
