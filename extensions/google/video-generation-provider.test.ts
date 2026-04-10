import { afterEach, describe, expect, it, vi } from "vitest";

const { GoogleGenAIMock, generateVideosMock, getVideosOperationMock } = vi.hoisted(() => {
  const generateVideosMock = vi.fn();
  const getVideosOperationMock = vi.fn();
  const GoogleGenAIMock = vi.fn(function GoogleGenAI() {
    return {
      files: {
        download: vi.fn(),
      },
      models: {
        generateVideos: generateVideosMock,
      },
      operations: {
        getVideosOperation: getVideosOperationMock,
      },
    };
  });
  return { GoogleGenAIMock, generateVideosMock, getVideosOperationMock };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: GoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { buildGoogleVideoGenerationProvider } from "./video-generation-provider.js";

describe("google video generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    generateVideosMock.mockReset();
    getVideosOperationMock.mockReset();
    GoogleGenAIMock.mockClear();
  });

  it("submits generation and returns inline video bytes", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      mode: "api-key",
      source: "env",
    });
    generateVideosMock.mockResolvedValue({
      done: false,
      name: "operations/123",
    });
    getVideosOperationMock.mockResolvedValue({
      done: true,
      name: "operations/123",
      response: {
        generatedVideos: [
          {
            video: {
              mimeType: "video/mp4",
              videoBytes: Buffer.from("mp4-bytes").toString("base64"),
            },
          },
        ],
      },
    });

    const provider = buildGoogleVideoGenerationProvider();
    const result = await provider.generateVideo({
      aspectRatio: "16:9",
      audio: true,
      cfg: {},
      durationSeconds: 3,
      model: "veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      provider: "google",
      resolution: "720P",
    });

    expect(generateVideosMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          aspectRatio: "16:9",
          durationSeconds: 4,
          generateAudio: true,
          numberOfVideos: 1,
          resolution: "720p",
        }),
        model: "veo-3.1-fast-generate-preview",
        prompt: "A tiny robot watering a windowsill garden",
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(GoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "google-key",
        httpOptions: expect.not.objectContaining({
          apiVersion: expect.anything(),
          baseUrl: expect.anything(),
        }),
      }),
    );
  });

  it("rejects mixed image and video inputs", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      mode: "api-key",
      source: "env",
    });
    const provider = buildGoogleVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        cfg: {},
        inputImages: [{ buffer: Buffer.from("img"), mimeType: "image/png" }],
        inputVideos: [{ buffer: Buffer.from("vid"), mimeType: "video/mp4" }],
        model: "veo-3.1-fast-generate-preview",
        prompt: "Animate",
        provider: "google",
      }),
    ).rejects.toThrow("Google video generation does not support image and video inputs together.");
  });

  it("rounds unsupported durations to the nearest Veo value", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      mode: "api-key",
      source: "env",
    });
    generateVideosMock.mockResolvedValue({
      done: true,
      response: {
        generatedVideos: [
          {
            video: {
              mimeType: "video/mp4",
              videoBytes: Buffer.from("mp4-bytes").toString("base64"),
            },
          },
        ],
      },
    });

    const provider = buildGoogleVideoGenerationProvider();
    await provider.generateVideo({
      cfg: {},
      durationSeconds: 5,
      model: "veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      provider: "google",
    });

    expect(generateVideosMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          durationSeconds: 6,
        }),
      }),
    );
  });
});
