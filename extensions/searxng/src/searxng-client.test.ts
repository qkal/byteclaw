import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import { __testing } from "./searxng-client.js";

function createLookupFn(addresses: { address: string; family: number }[]): LookupFn {
  return vi.fn(async (_hostname: string, options?: unknown) => {
    if (typeof options === "number" || !options || !(options as { all?: boolean }).all) {
      return addresses[0];
    }
    return addresses;
  }) as unknown as LookupFn;
}

describe("searxng client", () => {
  it("preserves a configured base-path prefix when building the search URL", () => {
    expect(
      __testing.buildSearxngSearchUrl({
        baseUrl: "https://search.example.com/searxng",
        categories: "general,news",
        language: "en",
        query: "openclaw",
      }),
    ).toBe(
      "https://search.example.com/searxng/search?q=openclaw&format=json&categories=general%2Cnews&language=en",
    );
  });

  it("parses SearXNG JSON results and applies the requested count cap", () => {
    expect(
      __testing.parseSearxngResponseText(
        JSON.stringify({
          results: [
            { content: "A", title: "One", url: "https://example.com/1" },
            { content: "B", title: "Two", url: "https://example.com/2" },
          ],
        }),
        1,
      ),
    ).toEqual([{ content: "A", title: "One", url: "https://example.com/1" }]);
  });

  it("drops malformed result rows instead of failing the whole response", () => {
    expect(
      __testing.parseSearxngResponseText(
        JSON.stringify({
          results: [
            { content: "A", title: "One", url: "https://example.com/1" },
            { title: { text: "bad" }, url: "https://example.com/2" },
            { content: "bad-url", title: "Three", url: 3 },
            { content: { text: "bad" }, title: "Four", url: "https://example.com/4" },
          ],
        }),
        10,
      ),
    ).toEqual([
      { content: "A", title: "One", url: "https://example.com/1" },
      { content: undefined, title: "Four", url: "https://example.com/4" },
    ]);
  });

  it("rejects invalid JSON bodies", () => {
    expect(() => __testing.parseSearxngResponseText("{", 5)).toThrow(
      "SearXNG returned invalid JSON.",
    );
  });

  it("allows https public hosts", async () => {
    await expect(
      __testing.validateSearxngBaseUrl("https://search.example.com/searxng"),
    ).resolves.toBeUndefined();
  });

  it("allows cleartext private-network hosts", async () => {
    await expect(
      __testing.validateSearxngBaseUrl(
        "http://matrix-synapse:8080",
        createLookupFn([{ address: "10.0.0.5", family: 4 }]),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects cleartext public hosts", async () => {
    await expect(
      __testing.validateSearxngBaseUrl(
        "http://search.example.com:8080",
        createLookupFn([{ address: "93.184.216.34", family: 4 }]),
      ),
    ).rejects.toThrow(
      "SearXNG HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    );
  });
});
