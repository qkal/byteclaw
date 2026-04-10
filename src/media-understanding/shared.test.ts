import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

import {
  fetchWithTimeoutGuarded,
  postJsonRequest,
  postTranscriptionRequest,
  readErrorResponse,
  resolveProviderHttpRequestConfig,
} from "./shared.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveProviderHttpRequestConfig", () => {
  it("preserves explicit caller headers but protects attribution headers", () => {
    const resolved = resolveProviderHttpRequestConfig({
      api: "openai-audio-transcriptions",
      baseUrl: "https://api.openai.com/v1/",
      capability: "audio",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultHeaders: {
        "X-Default": "1",
        authorization: "Bearer default-token",
      },
      headers: {
        "User-Agent": "custom-agent/1.0",
        authorization: "Bearer override",
        originator: "spoofed",
      },
      provider: "openai",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("authorization")).toBe("Bearer override");
    expect(resolved.headers.get("x-default")).toBe("1");
    expect(resolved.headers.get("user-agent")).toMatch(/^openclaw\//);
    expect(resolved.headers.get("originator")).toBe("openclaw");
    expect(resolved.headers.get("version")).toBeTruthy();
  });

  it("uses the fallback base URL without enabling private-network access", () => {
    const resolved = resolveProviderHttpRequestConfig({
      capability: "audio",
      defaultBaseUrl: "https://api.deepgram.com/v1/",
      defaultHeaders: {
        authorization: "Token test-key",
      },
      provider: "deepgram",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.deepgram.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("authorization")).toBe("Token test-key");
  });

  it("allows callers to preserve custom-base detection before URL normalization", () => {
    const resolved = resolveProviderHttpRequestConfig({
      allowPrivateNetwork: false,
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      capability: "image",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultHeaders: {
        "x-goog-api-key": "test-key",
      },
      provider: "google",
      transport: "http",
    });

    expect(resolved.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("x-goog-api-key")).toBe("test-key");
  });

  it("surfaces dispatcher policy for explicit proxy and mTLS transport overrides", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://api.deepgram.com/v1",
      capability: "audio",
      defaultBaseUrl: "https://api.deepgram.com/v1",
      defaultHeaders: {
        authorization: "Token test-key",
      },
      provider: "deepgram",
      request: {
        proxy: {
          mode: "explicit-proxy",
          tls: {
            ca: "proxy-ca",
          },
          url: "http://proxy.internal:8443",
        },
        tls: {
          cert: "client-cert",
          key: "client-key",
        },
      },
      transport: "media-understanding",
    });

    expect(resolved.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyTls: {
        ca: "proxy-ca",
      },
      proxyUrl: "http://proxy.internal:8443",
    });
  });

  it("fails fast when no base URL can be resolved", () => {
    expect(() =>
      resolveProviderHttpRequestConfig({
        baseUrl: "   ",
        defaultBaseUrl: "   ",
      }),
    ).toThrow("Missing baseUrl");
  });
});

describe("readErrorResponse", () => {
  it("caps streamed error bodies instead of buffering the whole response", async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          controller.enqueue(encoder.encode("a".repeat(2048)));
          if (reads >= 10) {
            controller.close();
          }
        },
      }),
      {
        status: 500,
      },
    );

    const detail = await readErrorResponse(response);

    expect(detail).toBe(`${"a".repeat(300)}…`);
    expect(reads).toBe(2);
  });
});

describe("fetchWithTimeoutGuarded", () => {
  it("applies a default timeout when callers omit one", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      finalUrl: "https://example.com",
      release: async () => {},
      response: new Response(null, { status: 200 }),
    });

    await fetchWithTimeoutGuarded("https://example.com", {}, undefined, fetch);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 60_000,
        url: "https://example.com",
      }),
    );
  });

  it("sanitizes auditContext before passing it to the SSRF guard", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      finalUrl: "https://example.com",
      release: async () => {},
      response: new Response(null, { status: 200 }),
    });

    await fetchWithTimeoutGuarded("https://example.com", {}, 5000, fetch, {
      auditContext: "provider-http\r\nfal\timage\u001btest",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "provider-http fal image test",
        timeoutMs: 5000,
      }),
    );
  });

  it("passes configured explicit proxy policy through the SSRF guard", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      finalUrl: "https://example.com",
      release: async () => {},
      response: new Response(null, { status: 200 }),
    });

    await postJsonRequest({
      body: { hello: "world" },
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://169.254.169.254:8080",
      },
      fetchFn: fetch,
      headers: new Headers({ authorization: "Token test-key" }),
      url: "https://api.deepgram.com/v1/listen",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "http://169.254.169.254:8080",
        },
      }),
    );
  });

  it("forwards explicit pinDns overrides to JSON requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      finalUrl: "https://example.com",
      release: async () => {},
      response: new Response(null, { status: 200 }),
    });

    await postJsonRequest({
      body: { ok: true },
      fetchFn: fetch,
      headers: new Headers(),
      pinDns: false,
      url: "https://api.example.com/v1/test",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pinDns: false,
      }),
    );
  });

  it("forwards explicit pinDns overrides to transcription requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      finalUrl: "https://example.com",
      release: async () => {},
      response: new Response(null, { status: 200 }),
    });

    await postTranscriptionRequest({
      body: "audio-bytes",
      fetchFn: fetch,
      headers: new Headers(),
      pinDns: false,
      url: "https://api.example.com/v1/transcriptions",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pinDns: false,
      }),
    );
  });
});
