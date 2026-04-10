import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import { performMatrixRequest } from "./transport.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

function clearTestUndiciRuntimeDepsOverride(): void {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
}

describe("performMatrixRequest", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    clearTestUndiciRuntimeDepsOverride();
  });

  afterEach(() => {
    clearTestUndiciRuntimeDepsOverride();
  });

  it("rejects oversized raw responses before buffering the whole body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("too-big", {
            headers: {
              "content-length": "8192",
            },
            status: 200,
          }),
      ),
    );

    await expect(
      performMatrixRequest({
        accessToken: "token",
        endpoint: "/_matrix/media/v3/download/example/id",
        homeserver: "http://127.0.0.1:8008",
        maxBytes: 1024,
        method: "GET",
        raw: true,
        ssrfPolicy: { allowPrivateNetwork: true },
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
  });

  it("applies streaming byte limits when raw responses omit content-length", async () => {
    const chunk = new Uint8Array(768);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
          }),
      ),
    );

    await expect(
      performMatrixRequest({
        accessToken: "token",
        endpoint: "/_matrix/media/v3/download/example/id",
        homeserver: "http://127.0.0.1:8008",
        maxBytes: 1024,
        method: "GET",
        raw: true,
        ssrfPolicy: { allowPrivateNetwork: true },
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
  });

  it("uses the matrix-specific idle-timeout error for stalled raw downloads", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(stream, {
              status: 200,
            }),
        ),
      );

      const requestPromise = performMatrixRequest({
        accessToken: "token",
        endpoint: "/_matrix/media/v3/download/example/id",
        homeserver: "http://127.0.0.1:8008",
        maxBytes: 1024,
        method: "GET",
        raw: true,
        readIdleTimeoutMs: 50,
        ssrfPolicy: { allowPrivateNetwork: true },
        timeoutMs: 5000,
      });

      const rejection = expect(requestPromise).rejects.toThrow(
        "Matrix media download stalled: no data received for 50ms",
      );
      await vi.advanceTimersByTimeAsync(60);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 5000);

  it("uses undici runtime fetch for pinned Matrix requests so the dispatcher stays bound", async () => {
    let ambientFetchCalls = 0;
    vi.stubGlobal("fetch", (async () => {
      ambientFetchCalls += 1;
      throw new Error("expected pinned Matrix requests to avoid ambient fetch");
    }) as typeof fetch);
    const runtimeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      expect(requestInit.dispatcher).toBeDefined();
      return new Response('{"ok":true}', {
        headers: {
          "content-type": "application/json",
        },
        status: 200,
      });
    });
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: class MockAgent {},
      EnvHttpProxyAgent: class MockEnvHttpProxyAgent {},
      ProxyAgent: class MockProxyAgent {},
      fetch: runtimeFetch,
    };

    const result = await performMatrixRequest({
      accessToken: "token",
      endpoint: "/_matrix/client/v3/account/whoami",
      homeserver: "http://127.0.0.1:8008",
      method: "GET",
      ssrfPolicy: { allowPrivateNetwork: true },
      timeoutMs: 5000,
    });

    expect(result.text).toBe('{"ok":true}');
    expect(ambientFetchCalls).toBe(0);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(
      (runtimeFetch.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown })?.dispatcher,
    ).toBeDefined();
  });
});
