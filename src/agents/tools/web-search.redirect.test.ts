import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { withStrictWebToolsEndpointMock } = vi.hoisted(() => ({
  withStrictWebToolsEndpointMock: vi.fn(),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  withStrictWebToolsEndpoint: withStrictWebToolsEndpointMock,
}));

let resolveCitationRedirectUrl: typeof import("./web-search-citation-redirect.js").resolveCitationRedirectUrl;

describe("web_search redirect resolution hardening", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ resolveCitationRedirectUrl } = await import("./web-search-citation-redirect.js"));
  });

  beforeEach(() => {
    withStrictWebToolsEndpointMock.mockReset();
  });

  it("resolves redirects via SSRF-guarded HEAD requests", async () => {
    withStrictWebToolsEndpointMock.mockImplementation(
      async (_params, run) =>
        await run({
          finalUrl: "https://example.com/final",
          response: new Response(null, { status: 200 }),
        }),
    );

    const resolved = await resolveCitationRedirectUrl("https://example.com/start");
    expect(resolved).toBe("https://example.com/final");
    expect(withStrictWebToolsEndpointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        init: { method: "HEAD" },
        timeoutMs: 5000,
        url: "https://example.com/start",
      }),
      expect.any(Function),
    );
  });

  it("falls back to the original URL when guarded resolution fails", async () => {
    withStrictWebToolsEndpointMock.mockRejectedValue(new Error("blocked"));
    await expect(resolveCitationRedirectUrl("https://example.com/start")).resolves.toBe(
      "https://example.com/start",
    );
  });
});
