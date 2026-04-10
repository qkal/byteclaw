import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/infra/retry.js", () => ({
  retryAsync: vi.fn(async (run: () => Promise<unknown>) => await run()),
}));

vi.mock("./post-json.js", () => ({
  postJson: vi.fn(),
}));

describe("postJsonWithRetry", () => {
  let retryAsyncMock: ReturnType<
    typeof vi.mocked<typeof import("../../../../src/infra/retry.js").retryAsync>
  >;
  let postJsonMock: ReturnType<typeof vi.mocked<typeof import("./post-json.js").postJson>>;
  let postJsonWithRetry: typeof import("./batch-http.js").postJsonWithRetry;

  beforeAll(async () => {
    ({ postJsonWithRetry } = await import("./batch-http.js"));
    const retryModule = await import("../../../../src/infra/retry.js");
    const postJsonModule = await import("./post-json.js");
    retryAsyncMock = vi.mocked(retryModule.retryAsync);
    postJsonMock = vi.mocked(postJsonModule.postJson);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts JSON and returns parsed response payload", async () => {
    postJsonMock.mockImplementationOnce(async (params) => await params.parse({ ids: [1, 2], ok: true }));

    const result = await postJsonWithRetry<{ ok: boolean; ids: number[] }>({
      body: { chunks: ["a", "b"] },
      errorPrefix: "memory batch failed",
      headers: { Authorization: "Bearer test" },
      url: "https://memory.example/v1/batch",
    });

    expect(result).toEqual({ ids: [1, 2], ok: true });
    expect(postJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachStatus: true,
        body: { chunks: ["a", "b"] },
        errorPrefix: "memory batch failed",
        headers: { Authorization: "Bearer test" },
        url: "https://memory.example/v1/batch",
      }),
    );

    const retryOptions = retryAsyncMock.mock.calls[0]?.[1] as
      | {
          attempts: number;
          minDelayMs: number;
          maxDelayMs: number;
          shouldRetry: (err: unknown) => boolean;
        }
      | undefined;
    expect(retryOptions?.attempts).toBe(3);
    expect(retryOptions?.minDelayMs).toBe(300);
    expect(retryOptions?.maxDelayMs).toBe(2000);
    expect(retryOptions?.shouldRetry({ status: 429 })).toBe(true);
    expect(retryOptions?.shouldRetry({ status: 503 })).toBe(true);
    expect(retryOptions?.shouldRetry({ status: 400 })).toBe(false);
  });

  it("attaches status to non-ok errors", async () => {
    postJsonMock.mockRejectedValueOnce(
      Object.assign(new Error("memory batch failed: 503 backend down"), { status: 503 }),
    );

    await expect(
      postJsonWithRetry({
        body: { chunks: [] },
        errorPrefix: "memory batch failed",
        headers: {},
        url: "https://memory.example/v1/batch",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("memory batch failed: 503 backend down"),
      status: 503,
    });
  });
});
