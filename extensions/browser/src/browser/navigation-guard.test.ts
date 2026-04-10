import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LookupFn, SsrFBlockedError } from "../infra/net/ssrf.js";
import {
  InvalidBrowserNavigationUrlError,
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  requiresInspectableBrowserNavigationRedirects,
} from "./navigation-guard.js";

function createLookupFn(address: string): LookupFn {
  const family = address.includes(":") ? 6 : 4;
  return vi.fn(async () => [{ address, family }]) as unknown as LookupFn;
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

describe("browser navigation guard", () => {
  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks private loopback URLs by default", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://127.0.0.1:8080",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows about:blank", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "about:blank",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks file URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks data URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "data:text/html,<h1>owned</h1>",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks javascript URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "javascript:alert(1)",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks non-blank about URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "about:srcdoc",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("allows blocked hostnames when explicitly allowed", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationAllowed({
        lookupFn,
        ssrfPolicy: {
          allowedHostnames: ["agent.internal"],
        },
        url: "http://agent.internal:3000",
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("agent.internal", { all: true });
  });

  it("blocks hostnames that resolve to private addresses by default", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationAllowed({
        lookupFn,
        url: "https://example.com",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows hostnames that resolve to public addresses", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        lookupFn,
        url: "https://example.com",
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("blocks strict policy navigation when env proxy is configured", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        lookupFn,
        url: "https://example.com",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("allows env proxy navigation when private-network mode is explicitly enabled", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        lookupFn,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        url: "https://example.com",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "not a url",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("validates final network URLs after navigation", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationResultAllowed({
        lookupFn,
        url: "http://private.test",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("ignores non-network browser-internal final URLs", async () => {
    await expect(
      assertBrowserNavigationResultAllowed({
        url: "chrome-error://chromewebdata/",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks private intermediate redirect hops", async () => {
    const publicLookup = createLookupFn("93.184.216.34");
    const privateLookup = createLookupFn("127.0.0.1");
    const finalRequest = {
      redirectedFrom: () => ({
        redirectedFrom: () => ({
          url: () => "https://public.example/start",
          redirectedFrom: () => null,
        }),
        url: () => "http://private.example/internal",
      }),
      url: () => "https://public.example/final",
    };

    await expect(
      assertBrowserNavigationRedirectChainAllowed({
        lookupFn: vi.fn(async (hostname: string) =>
          hostname === "private.example"
            ? privateLookup(hostname, { all: true })
            : publicLookup(hostname, { all: true }),
        ) as unknown as LookupFn,
        request: finalRequest,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows redirect chains when every hop is public", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    const finalRequest = {
      redirectedFrom: () => ({
        redirectedFrom: () => ({
          url: () => "https://public.example/start",
          redirectedFrom: () => null,
        }),
        url: () => "https://public.example/middle",
      }),
      url: () => "https://public.example/final",
    };

    await expect(
      assertBrowserNavigationRedirectChainAllowed({
        lookupFn,
        request: finalRequest,
      }),
    ).resolves.toBeUndefined();
  });

  it("treats default browser SSRF mode as requiring redirect-hop inspection", () => {
    expect(requiresInspectableBrowserNavigationRedirects()).toBe(true);
    expect(requiresInspectableBrowserNavigationRedirects({ allowPrivateNetwork: true })).toBe(
      false,
    );
  });
});
