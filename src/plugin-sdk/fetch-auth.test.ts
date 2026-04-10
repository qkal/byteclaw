import { describe, expect, it, vi } from "vitest";
import { fetchWithBearerAuthScopeFallback } from "./fetch-auth.js";
import { resolveRequestUrl } from "./request-url.js";

const asFetch = (fn: unknown): typeof fetch => fn as typeof fetch;

describe("fetchWithBearerAuthScopeFallback", () => {
  it("rejects non-https urls when https is required", async () => {
    await expect(
      fetchWithBearerAuthScopeFallback({
        requireHttps: true,
        scopes: [],
        url: "http://example.com/file",
      }),
    ).rejects.toThrow("URL must use HTTPS");
  });

  it.each([
    {
      expectedAuthHeader: null,
      expectedFetchCalls: 1,
      expectedStatus: 200,
      expectedTokenCalls: [] as string[],
      name: "returns immediately when the first attempt succeeds",
      responses: [new Response("ok", { status: 200 })],
      scopes: ["https://graph.microsoft.com"],
      shouldAttachAuth: undefined,
      url: "https://example.com/file",
    },
    {
      expectedAuthHeader: "Bearer token-1",
      expectedFetchCalls: 2,
      expectedStatus: 200,
      expectedTokenCalls: ["https://graph.microsoft.com"],
      name: "retries with auth scopes after a 401 response",
      responses: [
        new Response("unauthorized", { status: 401 }),
        new Response("ok", { status: 200 }),
      ],
      scopes: ["https://graph.microsoft.com", "https://api.botframework.com"],
      shouldAttachAuth: undefined,
      url: "https://graph.microsoft.com/v1.0/me",
    },
    {
      expectedAuthHeader: null,
      expectedFetchCalls: 1,
      expectedStatus: 401,
      expectedTokenCalls: [] as string[],
      name: "does not attach auth when host predicate rejects url",
      responses: [new Response("unauthorized", { status: 401 })],
      scopes: ["https://graph.microsoft.com"],
      shouldAttachAuth: () => false,
      url: "https://example.com/file",
    },
  ])(
    "$name",
    async ({
      url,
      scopes,
      responses,
      shouldAttachAuth,
      expectedStatus,
      expectedFetchCalls,
      expectedTokenCalls,
      expectedAuthHeader,
    }) => {
      const fetchFn = vi.fn();
      for (const response of responses) {
        fetchFn.mockResolvedValueOnce(response);
      }
      const tokenProvider = { getAccessToken: vi.fn(async () => "token-1") };

      const response = await fetchWithBearerAuthScopeFallback({
        fetchFn: asFetch(fetchFn),
        scopes,
        shouldAttachAuth,
        tokenProvider,
        url,
      });

      expect(response.status).toBe(expectedStatus);
      expect(fetchFn).toHaveBeenCalledTimes(expectedFetchCalls);
      const tokenCalls = tokenProvider.getAccessToken.mock.calls as unknown as [string][];
      expect(tokenCalls.map(([scope]) => scope)).toEqual(expectedTokenCalls);
      if (expectedAuthHeader === null) {
        return;
      }
      const secondCallInit = fetchFn.mock.calls.at(1)?.[1] as RequestInit | undefined;
      const secondHeaders = new Headers(secondCallInit?.headers);
      expect(secondHeaders.get("authorization")).toBe(expectedAuthHeader);
    },
  );

  it("continues across scopes when token retrieval fails", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const tokenProvider = {
      getAccessToken: vi
        .fn()
        .mockRejectedValueOnce(new Error("first scope failed"))
        .mockResolvedValueOnce("token-2"),
    };

    const response = await fetchWithBearerAuthScopeFallback({
      fetchFn: asFetch(fetchFn),
      scopes: ["https://first.example", "https://second.example"],
      tokenProvider,
      url: "https://graph.microsoft.com/v1.0/me",
    });

    expect(response.status).toBe(200);
    expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(2);
    expect(tokenProvider.getAccessToken).toHaveBeenNthCalledWith(1, "https://first.example");
    expect(tokenProvider.getAccessToken).toHaveBeenNthCalledWith(2, "https://second.example");
  });
});

describe("resolveRequestUrl", () => {
  it.each([
    {
      expected: "https://example.com/a",
      input: "https://example.com/a",
      name: "resolves string input",
    },
    {
      expected: "https://example.com/b",
      input: new URL("https://example.com/b"),
      name: "resolves URL input",
    },
    {
      expected: "https://example.com/c",
      input: { url: "https://example.com/c" } as unknown as RequestInfo,
      name: "resolves object input with url field",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveRequestUrl(input)).toBe(expected);
  });
});
