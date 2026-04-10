import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

let postJson: typeof import("./post-json.js").postJson;
let withRemoteHttpResponse: typeof import("./remote-http.js").withRemoteHttpResponse;

describe("postJson", () => {
  let remoteHttpMock: ReturnType<typeof vi.mocked<typeof withRemoteHttpResponse>>;

  beforeAll(async () => {
    ({ postJson } = await import("./post-json.js"));
    ({ withRemoteHttpResponse } = await import("./remote-http.js"));
    remoteHttpMock = vi.mocked(withRemoteHttpResponse);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses JSON payload on successful response", async () => {
    remoteHttpMock.mockImplementationOnce(
      async (params) =>
        await params.onResponse(
          new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 }),
        ),
    );

    const result = await postJson({
      body: { input: ["x"] },
      errorPrefix: "post failed",
      headers: { Authorization: "Bearer test" },
      parse: (payload) => payload,
      url: "https://memory.example/v1/post",
    });

    expect(result).toEqual({ data: [{ embedding: [1, 2] }] });
  });

  it("attaches status to thrown error when requested", async () => {
    remoteHttpMock.mockImplementationOnce(
      async (params) => await params.onResponse(new Response("bad gateway", { status: 502 })),
    );

    await expect(
      postJson({
        attachStatus: true,
        body: {},
        errorPrefix: "post failed",
        headers: {},
        parse: () => ({}),
        url: "https://memory.example/v1/post",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("post failed: 502 bad gateway"),
      status: 502,
    });
  });
});
