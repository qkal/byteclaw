import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const postJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./post-json.js", () => ({
  postJson: postJsonMock,
}));

type EmbeddingsRemoteFetchModule = typeof import("./embeddings-remote-fetch.js");

let fetchRemoteEmbeddingVectors: EmbeddingsRemoteFetchModule["fetchRemoteEmbeddingVectors"];

describe("fetchRemoteEmbeddingVectors", () => {
  beforeAll(async () => {
    ({ fetchRemoteEmbeddingVectors } = await import("./embeddings-remote-fetch.js"));
  });

  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it("maps remote embedding response data to vectors", async () => {
    postJsonMock.mockImplementationOnce(
      async (params) =>
        await params.parse({
          data: [{ embedding: [0.1, 0.2] }, {}, { embedding: [0.3] }],
        }),
    );

    const vectors = await fetchRemoteEmbeddingVectors({
      body: { input: ["one", "two", "three"] },
      errorPrefix: "embedding fetch failed",
      headers: { Authorization: "Bearer test" },
      url: "https://memory.example/v1/embeddings",
    });

    expect(vectors).toEqual([[0.1, 0.2], [], [0.3]]);
    expect(postJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { input: ["one", "two", "three"] },
        errorPrefix: "embedding fetch failed",
        headers: { Authorization: "Bearer test" },
        url: "https://memory.example/v1/embeddings",
      }),
    );
  });

  it("throws a status-rich error on non-ok responses", async () => {
    postJsonMock.mockRejectedValueOnce(new Error("embedding fetch failed: 403 forbidden"));

    await expect(
      fetchRemoteEmbeddingVectors({
        body: { input: ["one"] },
        errorPrefix: "embedding fetch failed",
        headers: {},
        url: "https://memory.example/v1/embeddings",
      }),
    ).rejects.toThrow("embedding fetch failed: 403 forbidden");
  });
});
