import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMediaGenerationRuntimeMocks,
  resetVideoGenerationRuntimeMocks,
} from "../../test/helpers/media-generation/runtime-module-mocks.js";
import type { OpenClawConfig } from "../config/config.js";
import { generateVideo, listRuntimeVideoGenerationProviders } from "./runtime.js";
import type { VideoGenerationProvider } from "./types.js";

const mocks = getMediaGenerationRuntimeMocks();

vi.mock("./model-ref.js", () => ({
  parseVideoGenerationModelRef: mocks.parseVideoGenerationModelRef,
}));

vi.mock("./provider-registry.js", () => ({
  getVideoGenerationProvider: mocks.getVideoGenerationProvider,
  listVideoGenerationProviders: mocks.listVideoGenerationProviders,
}));

describe("video-generation runtime", () => {
  beforeEach(() => {
    resetVideoGenerationRuntimeMocks();
  });

  it("generates videos through the active video-generation provider", async () => {
    const authStore = { profiles: {}, version: 1 } as const;
    let seenAuthStore: unknown;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    const provider: VideoGenerationProvider = {
      capabilities: {},
      async generateVideo(req: { authStore?: unknown }) {
        seenAuthStore = req.authStore;
        return {
          model: "vid-v1",
          videos: [
            {
              buffer: Buffer.from("mp4-bytes"),
              mimeType: "video/mp4",
              fileName: "sample.mp4",
            },
          ],
        };
      },
      id: "video-plugin",
    };
    mocks.getVideoGenerationProvider.mockReturnValue(provider);

    const result = await generateVideo({
      agentDir: "/tmp/agent",
      authStore,
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a cat",
    });

    expect(result.provider).toBe("video-plugin");
    expect(result.model).toBe("vid-v1");
    expect(result.attempts).toEqual([]);
    expect(result.ignoredOverrides).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(result.videos).toEqual([
      {
        buffer: Buffer.from("mp4-bytes"),
        fileName: "sample.mp4",
        mimeType: "video/mp4",
      },
    ]);
  });

  it("auto-detects and falls through to another configured video-generation provider by default", async () => {
    mocks.getVideoGenerationProvider.mockImplementation((providerId: string) => {
      if (providerId === "openai") {
        return {
          capabilities: {},
          defaultModel: "sora-2",
          async generateVideo() {
            throw new Error("Your request was blocked by our moderation system.");
          },
          id: "openai",
          isConfigured: () => true,
        };
      }
      if (providerId === "runway") {
        return {
          capabilities: {},
          defaultModel: "gen4.5",
          async generateVideo() {
            return {
              model: "gen4.5",
              videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
            };
          },
          id: "runway",
          isConfigured: () => true,
        };
      }
      return undefined;
    });
    mocks.listVideoGenerationProviders.mockReturnValue([
      {
        capabilities: {},
        defaultModel: "sora-2",
        generateVideo: async () => ({ videos: [] }),
        id: "openai",
        isConfigured: () => true,
      },
      {
        capabilities: {},
        defaultModel: "gen4.5",
        generateVideo: async () => ({ videos: [] }),
        id: "runway",
        isConfigured: () => true,
      },
    ]);

    const result = await generateVideo({
      cfg: {} as OpenClawConfig,
      prompt: "animate a cat",
    });

    expect(result.provider).toBe("runway");
    expect(result.model).toBe("gen4.5");
    expect(result.attempts).toEqual([
      {
        error: "Your request was blocked by our moderation system.",
        model: "sora-2",
        provider: "openai",
      },
    ]);
  });

  it("lists runtime video-generation providers through the provider registry", () => {
    const providers: VideoGenerationProvider[] = [
      {
        capabilities: {
          generate: {
            supportsAudio: true,
          },
        },
        defaultModel: "vid-v1",
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        }),
        id: "video-plugin",
        models: ["vid-v1"],
      },
    ];
    mocks.listVideoGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeVideoGenerationProviders({ config: {} as OpenClawConfig })).toEqual(
      providers,
    );
    expect(mocks.listVideoGenerationProviders).toHaveBeenCalledWith({} as OpenClawConfig);
  });

  it("normalizes requested durations to supported provider values", async () => {
    let seenDurationSeconds: number | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    mocks.getVideoGenerationProvider.mockReturnValue({
      capabilities: {
        generate: {
          supportedDurationSeconds: [4, 6, 8],
        },
      },
      generateVideo: async (req) => {
        seenDurationSeconds = req.durationSeconds;
        return {
          model: "vid-v1",
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        };
      },
      id: "video-plugin",
    });

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1" },
          },
        },
      } as OpenClawConfig,
      durationSeconds: 5,
      prompt: "animate a cat",
    });

    expect(seenDurationSeconds).toBe(6);
    expect(result.normalization).toMatchObject({
      durationSeconds: {
        applied: 6,
        requested: 5,
        supportedValues: [4, 6, 8],
      },
    });
    expect(result.metadata).toMatchObject({
      normalizedDurationSeconds: 6,
      requestedDurationSeconds: 5,
      supportedDurationSeconds: [4, 6, 8],
    });
    expect(result.ignoredOverrides).toEqual([]);
  });

  it("ignores unsupported optional overrides per provider", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
          audio?: boolean;
          watermark?: boolean;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("openai/sora-2");
    mocks.getVideoGenerationProvider.mockReturnValue({
      capabilities: {
        generate: {
          supportsSize: true,
        },
      },
      generateVideo: async (req) => {
        seenRequest = {
          aspectRatio: req.aspectRatio,
          audio: req.audio,
          resolution: req.resolution,
          size: req.size,
          watermark: req.watermark,
        };
        return {
          model: "sora-2",
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        };
      },
      id: "openai",
    });

    const result = await generateVideo({
      aspectRatio: "16:9",
      audio: false,
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "openai/sora-2" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a lobster",
      resolution: "720P",
      size: "1280x720",
      watermark: false,
    });

    expect(seenRequest).toEqual({
      aspectRatio: undefined,
      audio: undefined,
      resolution: undefined,
      size: "1280x720",
      watermark: undefined,
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "aspectRatio", value: "16:9" },
      { key: "resolution", value: "720P" },
      { key: "audio", value: false },
      { key: "watermark", value: false },
    ]);
  });

  it("uses mode-specific capabilities for image-to-video requests", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("runway/gen4.5");
    mocks.getVideoGenerationProvider.mockReturnValue({
      capabilities: {
        generate: {
          supportsAspectRatio: false,
          supportsSize: true,
        },
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
          supportsAspectRatio: true,
          supportsSize: false,
        },
      },
      generateVideo: async (req) => {
        seenRequest = {
          aspectRatio: req.aspectRatio,
          resolution: req.resolution,
          size: req.size,
        };
        return {
          model: "gen4.5",
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        };
      },
      id: "runway",
    });

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "runway/gen4.5" },
          },
        },
      } as OpenClawConfig,
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
      prompt: "animate a lobster",
      size: "1280x720",
    });

    expect(seenRequest).toEqual({
      aspectRatio: "16:9",
      resolution: undefined,
      size: undefined,
    });
    expect(result.ignoredOverrides).toEqual([]);
    expect(result.normalization).toMatchObject({
      aspectRatio: {
        applied: "16:9",
        derivedFrom: "size",
      },
    });
    expect(result.metadata).toMatchObject({
      aspectRatioDerivedFromSize: "16:9",
      normalizedAspectRatio: "16:9",
      requestedSize: "1280x720",
    });
  });

  it("builds a generic config hint without hardcoded provider ids", async () => {
    mocks.listVideoGenerationProviders.mockReturnValue([
      {
        capabilities: {},
        defaultModel: "animate-v1",
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        }),
        id: "motion-one",
      },
    ]);
    mocks.getProviderEnvVars.mockReturnValue(["MOTION_ONE_API_KEY"]);

    const promise = generateVideo({ cfg: {} as OpenClawConfig, prompt: "animate a cat" });

    await expect(promise).rejects.toThrow("No video-generation model configured.");
    await expect(promise).rejects.toThrow(
      'Set agents.defaults.videoGenerationModel.primary to a provider/model like "motion-one/animate-v1".',
    );
    await expect(promise).rejects.toThrow("motion-one: MOTION_ONE_API_KEY");
  });
});
