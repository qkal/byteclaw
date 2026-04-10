import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { performMatrixRequestMock } = vi.hoisted(() => ({
  performMatrixRequestMock: vi.fn(),
}));

vi.mock("./transport.js", () => ({
  performMatrixRequest: performMatrixRequestMock,
}));

let MatrixAuthedHttpClient: typeof import("./http-client.js").MatrixAuthedHttpClient;

describe("MatrixAuthedHttpClient", () => {
  beforeAll(async () => {
    ({ MatrixAuthedHttpClient } = await import("./http-client.js"));
  });

  beforeEach(() => {
    performMatrixRequestMock.mockReset();
  });

  it("parses JSON responses and forwards absolute-endpoint opt-in", async () => {
    performMatrixRequestMock.mockResolvedValue({
      buffer: Buffer.from('{"ok":true}', "utf8"),
      response: new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
      text: '{"ok":true}',
    });

    const client = new MatrixAuthedHttpClient({
      accessToken: "token",
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://proxy.internal:8080",
      },
      homeserver: "https://matrix.example.org",
      ssrfPolicy: {
        allowPrivateNetwork: true,
      },
    });
    const result = await client.requestJson({
      allowAbsoluteEndpoint: true,
      endpoint: "https://matrix.example.org/_matrix/client/v3/account/whoami",
      method: "GET",
      timeoutMs: 5000,
    });

    expect(result).toEqual({ ok: true });
    expect(performMatrixRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowAbsoluteEndpoint: true,
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "http://proxy.internal:8080",
        },
        endpoint: "https://matrix.example.org/_matrix/client/v3/account/whoami",
        method: "GET",
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    );
  });

  it("returns plain text when response is not JSON", async () => {
    performMatrixRequestMock.mockResolvedValue({
      buffer: Buffer.from("pong", "utf8"),
      response: new Response("pong", {
        headers: { "content-type": "text/plain" },
        status: 200,
      }),
      text: "pong",
    });

    const client = new MatrixAuthedHttpClient({
      accessToken: "token",
      homeserver: "https://matrix.example.org",
    });
    const result = await client.requestJson({
      endpoint: "/_matrix/client/v3/ping",
      method: "GET",
      timeoutMs: 5000,
    });

    expect(result).toBe("pong");
  });

  it("returns raw buffers for media requests", async () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    performMatrixRequestMock.mockResolvedValue({
      buffer: payload,
      response: new Response(payload, { status: 200 }),
      text: payload.toString("utf8"),
    });

    const client = new MatrixAuthedHttpClient({
      accessToken: "token",
      homeserver: "https://matrix.example.org",
    });
    const result = await client.requestRaw({
      endpoint: "/_matrix/media/v3/download/example/id",
      method: "GET",
      timeoutMs: 5000,
    });

    expect(result).toEqual(payload);
  });

  it("raises HTTP errors with status code metadata", async () => {
    performMatrixRequestMock.mockResolvedValue({
      buffer: Buffer.from(JSON.stringify({ error: "forbidden" }), "utf8"),
      response: new Response(JSON.stringify({ error: "forbidden" }), {
        headers: { "content-type": "application/json" },
        status: 403,
      }),
      text: JSON.stringify({ error: "forbidden" }),
    });

    const client = new MatrixAuthedHttpClient({
      accessToken: "token",
      homeserver: "https://matrix.example.org",
    });
    await expect(
      client.requestJson({
        endpoint: "/_matrix/client/v3/rooms",
        method: "GET",
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({
      message: "forbidden",
      statusCode: 403,
    });
  });
});
