import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postJsonWithRetry: vi.fn(async () => ({ id: "batch_1", status: "in_progress" })),
  resolveCompletedBatchResult: vi.fn(async () => ({ outputFileId: "file_out" })),
  uploadBatchJsonlFile: vi.fn(async () => "file_in"),
  withRemoteHttpResponse: vi.fn(
    async (params: { url: string; onResponse: (res: Response) => Promise<unknown> }) => {
      if (params.url.endsWith("/files/file_out/content")) {
        return await params.onResponse(
          new Response(
            [
              JSON.stringify({
                custom_id: "0",
                response: {
                  body: { data: [{ embedding: [1, 0, 0], index: 0 }] },
                  status_code: 200,
                },
              }),
              JSON.stringify({
                custom_id: "1",
                response: {
                  body: { data: [{ embedding: [2, 0, 0], index: 0 }] },
                  status_code: 200,
                },
              }),
            ].join("\n"),
            { headers: { "Content-Type": "application/jsonl" }, status: 200 },
          ),
        );
      }
      return await params.onResponse(
        new Response(
          JSON.stringify({ id: "batch_1", output_file_id: "file_out", status: "completed" }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      );
    },
  ),
}));

vi.mock("./batch-embedding-common.js", async () => {
  const actual = await vi.importActual<typeof import("./batch-embedding-common.js")>(
    "./batch-embedding-common.js",
  );
  return {
    ...actual,
    postJsonWithRetry: mocks.postJsonWithRetry,
    resolveCompletedBatchResult: mocks.resolveCompletedBatchResult,
    uploadBatchJsonlFile: mocks.uploadBatchJsonlFile,
    withRemoteHttpResponse: mocks.withRemoteHttpResponse,
  };
});

describe("runOpenAiEmbeddingBatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps uploaded batch output rows back to embeddings", async () => {
    const { runOpenAiEmbeddingBatches, OPENAI_BATCH_ENDPOINT } = await import("./batch-openai.js");

    const result = await runOpenAiEmbeddingBatches({
      agentId: "main",
      concurrency: 3,
      openAi: {
        baseUrl: "https://api.openai.com/v1",
        fetchImpl: fetch,
        headers: { Authorization: "Bearer test" },
        model: "text-embedding-3-small",
      },
      pollIntervalMs: 1,
      requests: [
        {
          body: { input: "hello", model: "text-embedding-3-small" },
          custom_id: "0",
          method: "POST",
          url: OPENAI_BATCH_ENDPOINT,
        },
        {
          body: { input: "world", model: "text-embedding-3-small" },
          custom_id: "1",
          method: "POST",
          url: OPENAI_BATCH_ENDPOINT,
        },
      ],
      timeoutMs: 1000,
      wait: true,
    });

    expect(mocks.uploadBatchJsonlFile).toHaveBeenCalled();
    expect(mocks.postJsonWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          endpoint: OPENAI_BATCH_ENDPOINT,
          metadata: { agent: "main", source: "openclaw-memory" },
        }),
        errorPrefix: "openai batch create failed",
      }),
    );
    expect(result.get("0")).toEqual([1, 0, 0]);
    expect(result.get("1")).toEqual([2, 0, 0]);
  });
});
