import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildRunwayVideoGenerationProvider: typeof import("./video-generation-provider.js").buildRunwayVideoGenerationProvider;

beforeAll(async () => {
  ({ buildRunwayVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("runway video generation provider", () => {
  it("submits a text-to-video task, polls it, and downloads the output", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          id: "task-1",
        }),
      },
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        headers: new Headers(),
        json: async () => ({
          id: "task-1",
          output: ["https://example.com/out.mp4"],
          status: "SUCCEEDED",
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildRunwayVideoGenerationProvider();
    const result = await provider.generateVideo({
      aspectRatio: "16:9",
      cfg: {},
      durationSeconds: 4,
      model: "gen4.5",
      prompt: "a tiny lobster DJ under neon lights",
      provider: "runway",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          duration: 4,
          model: "gen4.5",
          promptText: "a tiny lobster DJ under neon lights",
          ratio: "1280:720",
        },
        url: "https://api.dev.runwayml.com/v1/text_to_video",
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.dev.runwayml.com/v1/tasks/task-1",
      expect.objectContaining({ method: "GET" }),
      120_000,
      fetch,
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        endpoint: "/v1/text_to_video",
        status: "SUCCEEDED",
        taskId: "task-1",
      }),
    );
  });

  it("accepts local image buffers by converting them into data URIs", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({ id: "task-2" }),
      },
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        headers: new Headers(),
        json: async () => ({
          id: "task-2",
          output: ["https://example.com/out.mp4"],
          status: "SUCCEEDED",
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildRunwayVideoGenerationProvider();
    await provider.generateVideo({
      aspectRatio: "1:1",
      cfg: {},
      durationSeconds: 6,
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      model: "gen4_turbo",
      prompt: "animate this frame",
      provider: "runway",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          duration: 6,
          promptImage: expect.stringMatching(/^data:image\/png;base64,/u),
          ratio: "960:960",
        }),
        url: "https://api.dev.runwayml.com/v1/image_to_video",
      }),
    );
  });

  it("requires gen4_aleph for video-to-video", async () => {
    const provider = buildRunwayVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        cfg: {},
        inputVideos: [{ url: "https://example.com/input.mp4" }],
        model: "gen4.5",
        prompt: "restyle this clip",
        provider: "runway",
      }),
    ).rejects.toThrow("Runway video-to-video currently requires model gen4_aleph.");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });
});
