import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getMinimaxProviderHttpMocks,
  installMinimaxProviderHttpMockCleanup,
  loadMinimaxVideoGenerationProviderModule,
} from "./provider-http.test-helpers.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getMinimaxProviderHttpMocks();

let buildMinimaxVideoGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxVideoGenerationProviderModule>
>["buildMinimaxVideoGenerationProvider"];

beforeAll(async () => {
  ({ buildMinimaxVideoGenerationProvider } = await loadMinimaxVideoGenerationProviderModule());
});

installMinimaxProviderHttpMockCleanup();

describe("minimax video generation provider", () => {
  it("creates a task, polls status, and downloads the generated video", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          base_resp: { status_code: 0 },
          task_id: "task-123",
        }),
      },
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          base_resp: { status_code: 0 },
          file_id: "file-1",
          status: "Success",
          task_id: "task-123",
          video_url: "https://example.com/out.mp4",
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildMinimaxVideoGenerationProvider();
    const result = await provider.generateVideo({
      cfg: {},
      durationSeconds: 5,
      model: "MiniMax-Hailuo-2.3",
      prompt: "A fox sprints across snowy hills",
      provider: "minimax",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          duration: 6,
        }),
        url: "https://api.minimax.io/v1/video_generation",
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        fileId: "file-1",
        taskId: "task-123",
      }),
    );
  });

  it("downloads via file_id when the status response omits video_url", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          base_resp: { status_code: 0 },
          task_id: "task-456",
        }),
      },
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          base_resp: { status_code: 0 },
          file_id: "file-9",
          status: "Success",
          task_id: "task-456",
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          base_resp: { status_code: 0 },
          file: {
            download_url: "https://example.com/download.mp4",
            file_id: "file-9",
            filename: "output_aigc.mp4",
          },
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildMinimaxVideoGenerationProvider();
    const result = await provider.generateVideo({
      cfg: {},
      model: "MiniMax-Hailuo-2.3",
      prompt: "A fox sprints across snowy hills",
      provider: "minimax",
    });

    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      2,
      "https://api.minimax.io/v1/files/retrieve?file_id=file-9",
      expect.objectContaining({
        method: "GET",
      }),
      expect.any(Number),
      expect.any(Function),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      3,
      "https://example.com/download.mp4",
      expect.objectContaining({
        method: "GET",
      }),
      expect.any(Number),
      expect.any(Function),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        fileId: "file-9",
        taskId: "task-456",
        videoUrl: undefined,
      }),
    );
  });
});
