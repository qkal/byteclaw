import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildXaiVideoGenerationProvider: typeof import("./video-generation-provider.js").buildXaiVideoGenerationProvider;

beforeAll(async () => {
  ({ buildXaiVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("xai video generation provider", () => {
  it("creates, polls, and downloads a generated video", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          request_id: "req_123",
        }),
      },
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_123",
          status: "done",
          video: { url: "https://cdn.x.ai/video.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildXaiVideoGenerationProvider();
    const result = await provider.generateVideo({
      aspectRatio: "16:9",
      cfg: {},
      durationSeconds: 6,
      model: "grok-imagine-video",
      prompt: "A tiny robot crab crossing a moonlit tide pool",
      provider: "xai",
      resolution: "720P",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          aspect_ratio: "16:9",
          duration: 6,
          model: "grok-imagine-video",
          prompt: "A tiny robot crab crossing a moonlit tide pool",
          resolution: "720p",
        }),
        url: "https://api.x.ai/v1/videos/generations",
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.x.ai/v1/videos/req_123",
      expect.objectContaining({ method: "GET" }),
      120_000,
      fetch,
    );
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        mode: "generate",
        requestId: "req_123",
      }),
    );
  });

  it("routes video inputs to the extension endpoint when duration is set", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          request_id: "req_extend",
        }),
      },
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_extend",
          status: "done",
          video: { url: "https://cdn.x.ai/extended.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("extended-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildXaiVideoGenerationProvider();
    await provider.generateVideo({
      cfg: {},
      durationSeconds: 8,
      inputVideos: [{ url: "https://example.com/input.mp4" }],
      model: "grok-imagine-video",
      prompt: "Continue the shot into a neon alleyway",
      provider: "xai",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          duration: 8,
          video: { url: "https://example.com/input.mp4" },
        }),
        url: "https://api.x.ai/v1/videos/extensions",
      }),
    );
  });
});
