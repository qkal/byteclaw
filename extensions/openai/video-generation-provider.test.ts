import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

const { postJsonRequestMock, fetchWithTimeoutMock, resolveProviderHttpRequestConfigMock } =
  getProviderHttpMocks();

let buildOpenAIVideoGenerationProvider: typeof import("./video-generation-provider.js").buildOpenAIVideoGenerationProvider;

beforeAll(async () => {
  ({ buildOpenAIVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("openai video generation provider", () => {
  it("uses JSON for text-only Sora requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          id: "vid_123",
          model: "sora-2",
          status: "queued",
        }),
      },
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_123",
          model: "sora-2",
          seconds: "4",
          size: "720x1280",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    const result = await provider.generateVideo({
      cfg: {},
      durationSeconds: 4,
      model: "sora-2",
      prompt: "A paper airplane gliding through golden hour light",
      provider: "openai",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/videos",
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.openai.com/v1/videos/vid_123",
      expect.objectContaining({ method: "GET" }),
      120_000,
      fetch,
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        status: "completed",
        videoId: "vid_123",
      }),
    );
  });

  it("uses JSON input_reference.image_url for image-to-video requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          id: "vid_456",
          model: "sora-2",
          status: "queued",
        }),
      },
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_456",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      model: "sora-2",
      prompt: "Animate this frame",
      provider: "openai",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          input_reference: {
            image_url: "data:image/png;base64,cG5nLWJ5dGVz",
          },
        }),
        url: "https://api.openai.com/v1/videos",
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.openai.com/v1/videos/vid_456",
      expect.objectContaining({
        method: "GET",
      }),
      120_000,
      fetch,
    );
  });

  it("honors configured baseUrl for video requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          id: "vid_local",
          model: "sora-2",
          status: "queued",
        }),
      },
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_local",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
      model: "sora-2",
      prompt: "Render via local relay",
      provider: "openai",
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:44080/v1",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: false,
        url: "http://127.0.0.1:44080/v1/videos",
      }),
    );
  });

  it("uses multipart input_reference for video-to-video uploads", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_789",
          model: "sora-2",
          status: "queued",
        }),
        ok: true,
      })
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_789",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      cfg: {},
      inputVideos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
      model: "sora-2",
      prompt: "Remix this clip",
      provider: "openai",
    });

    expect(postJsonRequestMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.openai.com/v1/videos",
      expect.objectContaining({
        body: expect.any(FormData),
        method: "POST",
      }),
      120_000,
      fetch,
    );
  });

  it("rejects multiple reference assets", async () => {
    const provider = buildOpenAIVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        cfg: {},
        inputImages: [{ buffer: Buffer.from("a"), mimeType: "image/png" }],
        inputVideos: [{ buffer: Buffer.from("b"), mimeType: "video/mp4" }],
        model: "sora-2",
        prompt: "Animate these",
        provider: "openai",
      }),
    ).rejects.toThrow("OpenAI video generation supports at most one reference image or video.");
  });
});
