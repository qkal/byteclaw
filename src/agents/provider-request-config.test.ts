import { describe, expect, it } from "vitest";
import type { ConfiguredProviderRequest } from "../config/types.provider-request.js";
import type { SecretRef } from "../config/types.secrets.js";
import {
  buildProviderRequestDispatcherPolicy,
  mergeModelProviderRequestOverrides,
  mergeProviderRequestOverrides,
  resolveProviderRequestConfig,
  resolveProviderRequestHeaders,
  resolveProviderRequestPolicyConfig,
  sanitizeConfiguredModelProviderRequest,
  sanitizeConfiguredProviderRequest,
  sanitizeRuntimeProviderRequestOverrides,
} from "./provider-request-config.js";

describe("provider request config", () => {
  it("merges discovered, provider, and model headers in precedence order", () => {
    const resolved = resolveProviderRequestConfig({
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      capability: "llm",
      discoveredHeaders: {
        "X-Discovered": "1",
        "X-Shared": "discovered",
      },
      modelHeaders: {
        "X-Model": "3",
        "X-Shared": "model",
      },
      provider: "custom-openai",
      providerHeaders: {
        "X-Provider": "2",
        "X-Shared": "provider",
      },
      transport: "stream",
    });

    expect(resolved.headers).toEqual({
      "X-Discovered": "1",
      "X-Model": "3",
      "X-Provider": "2",
      "X-Shared": "model",
    });
  });

  it("surfaces authHeader intent without mutating headers yet", () => {
    const resolved = resolveProviderRequestConfig({
      api: "google-generative-ai",
      authHeader: true,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      capability: "llm",
      provider: "google",
      transport: "stream",
    });

    expect(resolved.auth).toEqual({
      configured: false,
      injectAuthorizationHeader: true,
      mode: "authorization-bearer",
    });
    expect(resolved.headers).toBeUndefined();
  });

  it("keeps future proxy and tls slots stable for current callers", () => {
    const resolved = resolveProviderRequestConfig({
      api: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
      capability: "llm",
      provider: "openrouter",
      transport: "stream",
    });

    expect(resolved.proxy).toEqual({ configured: false });
    expect(resolved.tls).toEqual({ configured: false });
    expect(resolved.policy.endpointClass).toBe("openrouter");
    expect(resolved.policy.attributionProvider).toBe("openrouter");
    expect(resolved.extraHeaders).toEqual({
      configured: false,
      headers: undefined,
    });
  });

  it("normalizes transport overrides into auth, extra headers, proxy, and tls slots", () => {
    const resolved = resolveProviderRequestConfig({
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      capability: "llm",
      provider: "custom-openai",
      request: {
        auth: {
          headerName: "api-key",
          mode: "header",
          value: "secret",
        },
        headers: {
          "X-Tenant": "acme",
        },
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
          serverName: "gateway.internal",
        },
      },
      transport: "stream",
    });

    expect(resolved.extraHeaders).toEqual({
      configured: true,
      headers: {
        "X-Tenant": "acme",
        "api-key": "secret",
      },
    });
    expect(resolved.auth).toEqual({
      configured: true,
      headerName: "api-key",
      injectAuthorizationHeader: false,
      mode: "header",
      value: "secret",
    });
    expect(resolved.proxy).toEqual({
      configured: true,
      mode: "explicit-proxy",
      proxyUrl: "http://proxy.internal:8443",
      tls: {
        ca: "proxy-ca",
        configured: true,
      },
    });
    expect(resolved.tls).toEqual({
      cert: "client-cert",
      configured: true,
      key: "client-key",
      serverName: "gateway.internal",
    });
  });

  it("drops legacy Authorization when a custom auth header override is configured", () => {
    const resolved = resolveProviderRequestConfig({
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      capability: "llm",
      provider: "custom-openai",
      providerHeaders: {
        Authorization: "Bearer stale-token",
        "X-Tenant": "acme",
      },
      request: {
        auth: {
          headerName: "api-key",
          mode: "header",
          value: "secret",
        },
      },
      transport: "stream",
    });

    expect(resolved.headers).toEqual({
      "X-Tenant": "acme",
      "api-key": "secret",
    });
  });

  it("builds explicit proxy dispatcher policy from normalized transport config", () => {
    const resolved = resolveProviderRequestConfig({
      baseUrl: "https://proxy.example.com/v1",
      provider: "custom-openai",
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
    });

    expect(buildProviderRequestDispatcherPolicy(resolved)).toEqual({
      mode: "explicit-proxy",
      proxyTls: {
        ca: "proxy-ca",
      },
      proxyUrl: "http://proxy.internal:8443",
    });
  });

  it("does not copy target TLS into env proxy TLS", () => {
    const resolved = resolveProviderRequestConfig({
      baseUrl: "https://proxy.example.com/v1",
      provider: "custom-openai",
      request: {
        proxy: {
          mode: "env-proxy",
        },
        tls: {
          cert: "client-cert",
          key: "client-key",
          serverName: "gateway.internal",
        },
      },
    });

    expect(buildProviderRequestDispatcherPolicy(resolved)).toEqual({
      connect: {
        cert: "client-cert",
        key: "client-key",
        servername: "gateway.internal",
      },
      mode: "env-proxy",
    });
  });

  it("rejects insecure TLS transport overrides", () => {
    expect(() =>
      resolveProviderRequestConfig({
        baseUrl: "https://proxy.example.com/v1",
        provider: "custom-openai",
        request: {
          tls: {
            insecureSkipVerify: true,
          },
        },
      }),
    ).toThrow(/insecureskipverify/i);
  });

  it("rejects proxy and tls runtime auth overrides", () => {
    expect(() =>
      sanitizeRuntimeProviderRequestOverrides({
        headers: {
          "X-Tenant": "acme",
        },
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      }),
    ).toThrow(/runtime auth request overrides do not allow proxy or tls/i);
  });

  it("sanitizes configured request overrides into runtime transport overrides", () => {
    expect(
      sanitizeConfiguredProviderRequest({
        auth: {
          mode: "authorization-bearer",
          token: "secret",
        },
        headers: {
          "X-Tenant": "acme",
        },
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
          serverName: "gateway.internal",
        },
      }),
    ).toEqual({
      auth: {
        mode: "authorization-bearer",
        token: "secret",
      },
      headers: {
        "X-Tenant": "acme",
      },
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
        serverName: "gateway.internal",
      },
    });
  });

  it("fails fast when configured request overrides still contain unresolved SecretRefs", () => {
    const tenantRef: SecretRef = {
      id: "MEDIA_AUDIO_TENANT",
      provider: "default",
      source: "env",
    };
    const tokenRef: SecretRef = {
      id: "MEDIA_AUDIO_TOKEN",
      provider: "default",
      source: "env",
    };
    const certRef: SecretRef = {
      id: "MEDIA_AUDIO_CERT",
      provider: "default",
      source: "env",
    };
    expect(() =>
      sanitizeConfiguredProviderRequest({
        auth: {
          mode: "authorization-bearer",
          token: tokenRef,
        },
        headers: {
          "X-Tenant": tenantRef,
        },
        tls: {
          cert: certRef,
        },
      }),
    ).toThrow(/request\.(headers\.X-Tenant|auth\.token|tls\.cert): unresolved SecretRef/i);
  });

  it("keeps model-provider transport overrides once the llm path can carry them", () => {
    expect(
      sanitizeConfiguredModelProviderRequest({
        headers: {
          "X-Tenant": "acme",
        },
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      }),
    ).toEqual({
      headers: {
        "X-Tenant": "acme",
      },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.internal:8443",
      },
    });
  });

  it("preserves request.allowPrivateNetwork for operator-trusted LAN/overlay model bases", () => {
    expect(sanitizeConfiguredModelProviderRequest({ allowPrivateNetwork: true })).toEqual({
      allowPrivateNetwork: true,
    });
    expect(sanitizeConfiguredModelProviderRequest({ allowPrivateNetwork: false })).toEqual({
      allowPrivateNetwork: false,
    });
    expect(
      sanitizeConfiguredProviderRequest({
        allowPrivateNetwork: true,
      } as ConfiguredProviderRequest),
    ).toBeUndefined();
  });

  it("merges allowPrivateNetwork with later override winning", () => {
    expect(
      mergeModelProviderRequestOverrides(
        { allowPrivateNetwork: true },
        { allowPrivateNetwork: false },
      ),
    ).toEqual({ allowPrivateNetwork: false });
    expect(
      mergeModelProviderRequestOverrides(
        { allowPrivateNetwork: false },
        { allowPrivateNetwork: true },
      ),
    ).toEqual({ allowPrivateNetwork: true });
  });

  it("merges configured request overrides with later entries winning", () => {
    expect(
      mergeProviderRequestOverrides(
        {
          auth: {
            mode: "authorization-bearer",
            token: "provider-token",
          },
          headers: {
            "X-Provider": "1",
            "X-Shared": "provider",
          },
        },
        {
          auth: {
            headerName: "api-key",
            mode: "header",
            value: "entry-key",
          },
          headers: {
            "X-Entry": "2",
            "X-Shared": "entry",
          },
        },
      ),
    ).toEqual({
      auth: {
        headerName: "api-key",
        mode: "header",
        value: "entry-key",
      },
      headers: {
        "X-Entry": "2",
        "X-Provider": "1",
        "X-Shared": "entry",
      },
    });
  });

  it("lets defaults override caller headers when requested", () => {
    const resolved = resolveProviderRequestHeaders({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      callerHeaders: {
        "User-Agent": "spoofed/0.0.0",
        "X-Custom": "1",
        originator: "spoofed",
      },
      capability: "llm",
      precedence: "defaults-win",
      provider: "openai",
      transport: "stream",
    });

    expect(resolved).toMatchObject({
      "User-Agent": expect.stringMatching(/^openclaw\//),
      "X-Custom": "1",
      originator: "openclaw",
      version: expect.any(String),
    });
  });

  it("lets caller headers override defaults when requested", () => {
    const resolved = resolveProviderRequestHeaders({
      api: "openai-completions",
      callerHeaders: {
        "HTTP-Referer": "https://example.com",
        "X-Custom": "1",
      },
      capability: "llm",
      precedence: "caller-wins",
      provider: "openrouter",
      transport: "stream",
    });

    expect(resolved).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-Custom": "1",
      "X-OpenRouter-Categories": "cli-agent",
      "X-OpenRouter-Title": "OpenClaw",
    });
  });

  it("merges header names case-insensitively", () => {
    const resolved = resolveProviderRequestHeaders({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      callerHeaders: {
        "user-agent": "custom-agent/1.0",
      },
      capability: "llm",
      precedence: "caller-wins",
      provider: "openai",
      transport: "stream",
    });

    expect(
      Object.keys(resolved ?? {}).filter((key) => key.toLowerCase() === "user-agent"),
    ).toHaveLength(1);
    expect(resolved?.["User-Agent"]).toMatch(/^openclaw\//);
  });

  it("drops forbidden header keys while merging", () => {
    const resolved = resolveProviderRequestHeaders({
      callerHeaders: {
        "X-Custom": "1",
        __proto__: "polluted",
        constructor: "polluted",
      } as Record<string, string>,
      defaultHeaders: {
        prototype: "polluted",
      } as Record<string, string>,
      provider: "custom-openai",
    });

    expect(resolved).toEqual({
      "X-Custom": "1",
    });
    expect(Object.getPrototypeOf(resolved ?? {})).toBeNull();
  });

  it("unifies policy, capabilities, headers, base URL, and private-network posture", () => {
    const resolved = resolveProviderRequestPolicyConfig({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1/",
      callerHeaders: {
        "User-Agent": "custom-agent/1.0",
        "X-Custom": "1",
      },
      capability: "llm",
      compat: {
        supportsStore: true,
      },
      defaultBaseUrl: "https://fallback.example/v1/",
      precedence: "defaults-win",
      provider: "openai",
      providerHeaders: {
        authorization: "Bearer test-key",
      },
      transport: "stream",
    });

    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.policy.endpointClass).toBe("openai-public");
    expect(resolved.capabilities.allowsResponsesStore).toBe(true);
    expect(resolved.headers).toMatchObject({
      "User-Agent": expect.stringMatching(/^openclaw\//),
      "X-Custom": "1",
      authorization: "Bearer test-key",
      originator: "openclaw",
      version: expect.any(String),
    });
  });
});
