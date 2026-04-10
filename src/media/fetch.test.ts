import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  withStrictGuardedFetchMode: <T>(params: T) => params,
}));

type FetchRemoteMedia = typeof import("./fetch.js").fetchRemoteMedia;
type LookupFn = NonNullable<Parameters<FetchRemoteMedia>[0]["lookupFn"]>;
let fetchRemoteMedia: FetchRemoteMedia;

function makeStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeStallingFetch(firstChunk: Uint8Array) {
  return vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(firstChunk);
        },
      }),
      { status: 200 },
    ));
}

function makeLookupFn(): LookupFn {
  return vi.fn(async () => ({ address: "149.154.167.220", family: 4 })) as unknown as LookupFn;
}

async function expectRemoteMediaMaxBytesError(params: {
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"];
  maxBytes: number;
}) {
  await expect(
    fetchRemoteMedia({
      fetchImpl: params.fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: params.maxBytes,
      url: "https://example.com/file.bin",
    }),
  ).rejects.toThrow("exceeds maxBytes");
}

async function expectRedactedTelegramFetchError(params: {
  telegramFileUrl: string;
  telegramToken: string;
  redactedTelegramToken: string;
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"];
}) {
  const error = await fetchRemoteMedia({
    fetchImpl: params.fetchImpl,
    lookupFn: makeLookupFn(),
    maxBytes: 1024,
    ssrfPolicy: {
      allowRfc2544BenchmarkRange: true,
      allowedHostnames: ["api.telegram.org"],
    },
    url: params.telegramFileUrl,
  }).catch((error: unknown) => error as Error);

  expect(error).toBeInstanceOf(Error);
  const errorText = error instanceof Error ? String(error) : "";
  expect(errorText).not.toContain(params.telegramToken);
  expect(errorText).toContain(`bot${params.redactedTelegramToken}`);
}

async function expectFetchRemoteMediaRejected(params: {
  url: string;
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"];
  maxBytes?: number;
  readIdleTimeoutMs?: number;
  lookupFn?: LookupFn;
  expectedError: RegExp | string | Record<string, unknown>;
}) {
  const rejection = expect(
    fetchRemoteMedia({
      fetchImpl: params.fetchImpl,
      lookupFn: params.lookupFn ?? makeLookupFn(),
      maxBytes: params.maxBytes ?? 1024,
      url: params.url,
      ...(params.readIdleTimeoutMs ? { readIdleTimeoutMs: params.readIdleTimeoutMs } : {}),
    }),
  ).rejects;
  if (params.expectedError instanceof RegExp || typeof params.expectedError === "string") {
    await rejection.toThrow(params.expectedError);
    return;
  }
  await rejection.toMatchObject(params.expectedError);
}

async function expectFetchRemoteMediaResolvesToError(
  params: Parameters<typeof fetchRemoteMedia>[0],
): Promise<Error> {
  const result = await fetchRemoteMedia(params).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  if (!(result instanceof Error)) {
    expect.unreachable("expected fetchRemoteMedia to reject");
  }
  return result;
}

async function expectFetchRemoteMediaIdleTimeoutCase(params: {
  lookupFn: LookupFn;
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"];
  readIdleTimeoutMs: number;
  expectedError: Record<string, unknown>;
}) {
  vi.useFakeTimers();
  try {
    const rejection = expectFetchRemoteMediaRejected({
      expectedError: params.expectedError,
      fetchImpl: params.fetchImpl,
      lookupFn: params.lookupFn,
      readIdleTimeoutMs: params.readIdleTimeoutMs,
      url: "https://example.com/file.bin",
    });

    await vi.advanceTimersByTimeAsync(params.readIdleTimeoutMs + 5);
    await rejection;
  } finally {
    vi.useRealTimers();
  }
}

async function expectBoundedErrorBodyCase(
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"],
) {
  const result = await expectFetchRemoteMediaResolvesToError(
    createFetchRemoteMediaParams({
      fetchImpl,
      url: "https://example.com/file.bin",
    }),
  );
  expect(result.message).not.toContain("BAD");
  expect(result.message).not.toContain("body:");
}

async function expectPrivateIpFetchBlockedCase() {
  const fetchImpl = vi.fn();
  await expectFetchRemoteMediaRejected({
    expectedError: /private|internal|blocked/i,
    fetchImpl,
    url: "http://127.0.0.1/secret.jpg",
  });
  expect(fetchImpl).not.toHaveBeenCalled();
}

function createFetchRemoteMediaParams(
  params: Omit<Parameters<typeof fetchRemoteMedia>[0], "lookupFn"> & { lookupFn?: LookupFn },
) {
  return {
    lookupFn: params.lookupFn ?? makeLookupFn(),
    maxBytes: 1024,
    ...params,
  };
}

describe("fetchRemoteMedia", () => {
  const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
  const redactedTelegramToken = `${telegramToken.slice(0, 6)}…${telegramToken.slice(-4)}`;
  const telegramFileUrl = `https://api.telegram.org/file/bot${telegramToken}/photos/1.jpg`;

  beforeAll(async () => {
    ({ fetchRemoteMedia } = await import("./fetch.js"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    fetchWithSsrFGuardMock.mockReset().mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        url: string;
        fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        init?: RequestInit;
      };
      if (params.url.startsWith("http://127.0.0.1/")) {
        throw new Error("Blocked hostname or private/internal/special-use IP address");
      }
      const fetcher = params.fetchImpl ?? globalThis.fetch;
      if (!fetcher) {
        throw new Error("fetch is not available");
      }
      return {
        finalUrl: params.url,
        release: async () => {},
        response: await fetcher(params.url, params.init),
      };
    });
  });

  it.each([
    {
      fetchImpl: async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3, 4, 5])]), {
          headers: { "content-length": "5" },
          status: 200,
        }),
      name: "rejects when content-length exceeds maxBytes",
    },
    {
      fetchImpl: async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]), {
          status: 200,
        }),
      name: "rejects when streamed payload exceeds maxBytes",
    },
  ] as const)("$name", async ({ fetchImpl }) => {
    await expectRemoteMediaMaxBytesError({ fetchImpl, maxBytes: 4 });
  });

  it.each([
    {
      fetchImpl: vi.fn(async () => {
        throw new Error(`dial failed for ${telegramFileUrl}`);
      }),
      name: "redacts Telegram bot tokens from fetch failure messages",
    },
    {
      fetchImpl: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      name: "redacts Telegram bot tokens from HTTP error messages",
    },
  ] as const)("$name", async ({ fetchImpl }) => {
    await expectRedactedTelegramFetchError({
      fetchImpl,
      redactedTelegramToken,
      telegramFileUrl,
      telegramToken,
    });
  });

  it.each([
    {
      expectedError: {
        code: "fetch_failed",
        name: "MediaFetchError",
      },
      fetchImpl: makeStallingFetch(new Uint8Array([1, 2])),
      lookupFn: vi.fn(async () => ({
        address: "93.184.216.34",
        family: 4,
      })) as unknown as LookupFn,
      name: "aborts stalled body reads when idle timeout expires",
      readIdleTimeoutMs: 20,
    },
  ] as const)("$name", async ({ lookupFn, fetchImpl, readIdleTimeoutMs, expectedError }) => {
    await expectFetchRemoteMediaIdleTimeoutCase({
      expectedError,
      fetchImpl,
      lookupFn,
      readIdleTimeoutMs,
    });
  });

  it.each([
    {
      fetchImpl: vi.fn(
        async () =>
          new Response(makeStream([new TextEncoder().encode(`${" ".repeat(9000)}BAD`)]), {
            status: 400,
            statusText: "Bad Request",
          }),
      ),
      kind: "bounded-error-body" as const,
      name: "bounds error-body snippets instead of reading the full response",
    },
    {
      kind: "private-ip-block" as const,
      name: "blocks private IP literals before fetching",
    },
  ] as const)("$name", async (testCase) => {
    if (testCase.kind === "private-ip-block") {
      await expectPrivateIpFetchBlockedCase();
      return;
    }

    await expectBoundedErrorBodyCase(testCase.fetchImpl);
  });
});
