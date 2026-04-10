import { vi } from "vitest";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: async (params: {
    url: string;
    init?: RequestInit;
    fetchImpl?: typeof fetch;
  }) => {
    const fetchImpl = params.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("fetch is not available");
    }
    const response = await fetchImpl(params.url, params.init);
    return {
      finalUrl: params.url,
      release: async () => {},
      response,
    };
  },
}));

type FetchPayloadFactory = (input: RequestInfo | URL, init?: RequestInit) => unknown;

export type JsonFetchMock = ReturnType<typeof createJsonResponseFetchMock>;

export function createJsonResponseFetchMock(payload: unknown | FetchPayloadFactory) {
  const fetchMock = vi.fn<FetchMock>(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof payload === "function" ? payload(input, init) : payload;
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  });
  return withFetchPreconnect(fetchMock);
}

export function createEmbeddingDataFetchMock(embeddingValues = [0.1, 0.2, 0.3]) {
  return createJsonResponseFetchMock({ data: [{ embedding: embeddingValues }] });
}

export function createGeminiFetchMock(embeddingValues = [1, 2, 3]) {
  return createJsonResponseFetchMock({ embedding: { values: embeddingValues } });
}

export function createGeminiBatchFetchMock(count: number, embeddingValues = [1, 2, 3]) {
  return createJsonResponseFetchMock({
    embeddings: Array.from({ length: count }, () => ({ values: embeddingValues })),
  });
}

export function installFetchMock(fetchMock: typeof globalThis.fetch) {
  vi.stubGlobal("fetch", fetchMock);
}

export function readFirstFetchRequest(fetchMock: { mock: { calls: unknown[][] } }) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return { init: init as RequestInit | undefined, url };
}

export function parseFetchBody(fetchMock: { mock: { calls: unknown[][] } }, callIndex = 0) {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
}

export function mockResolvedProviderKey(
  resolveApiKeyForProvider: typeof import("../../agents/model-auth.js").resolveApiKeyForProvider,
  apiKey = "test-key",
) {
  vi.mocked(resolveApiKeyForProvider).mockResolvedValue({
    apiKey,
    mode: "api-key",
    source: "test",
  });
}
