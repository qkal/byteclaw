import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildBytePlusVideoGenerationProvider: typeof import("./video-generation-provider.js").buildBytePlusVideoGenerationProvider;

beforeAll(async () => {
  ({ buildBytePlusVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("byteplus video generation provider", () => {
  it("creates a content-generation task, polls, and downloads the video", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          id: "task_123",
        }),
      },
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          content: {
            video_url: "https://example.com/byteplus.mp4",
          },
          id: "task_123",
          model: "seedance-1-0-lite-t2v-250428",
          status: "succeeded",
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildBytePlusVideoGenerationProvider();
    const result = await provider.generateVideo({
      cfg: {},
      model: "seedance-1-0-lite-t2v-250428",
      prompt: "A lantern floats upward into the night sky",
      provider: "byteplus",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        taskId: "task_123",
      }),
    );
  });
});
