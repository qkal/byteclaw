import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isXaiToolEnabled,
  resolveFallbackXaiApiKey,
  resolveFallbackXaiAuth,
  resolveXaiToolApiKey,
} from "./tool-auth-shared.js";

describe("xai tool auth helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers plugin web search keys over legacy grok keys", () => {
    expect(
      resolveFallbackXaiApiKey({
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "plugin-key", // Pragma: allowlist secret
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: {
              grok: {
                apiKey: "legacy-key", // Pragma: allowlist secret
              },
            },
          },
        },
      }),
    ).toBe("plugin-key");
  });

  it("returns source metadata and managed markers for fallback auth", () => {
    expect(
      resolveFallbackXaiAuth({
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: { id: "/xai/tool-key", provider: "vault", source: "file" },
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      apiKey: NON_ENV_SECRETREF_MARKER,
      source: "plugins.entries.xai.config.webSearch.apiKey",
    });

    expect(
      resolveFallbackXaiAuth({
        tools: {
          web: {
            search: {
              grok: {
                apiKey: "legacy-key", // Pragma: allowlist secret
              },
            },
          },
        },
      }),
    ).toEqual({
      apiKey: "legacy-key",
      source: "tools.web.search.grok.apiKey",
    });
  });

  it("falls back to runtime, then source config, then env for tool auth", () => {
    vi.stubEnv("XAI_API_KEY", "env-key");

    expect(
      resolveXaiToolApiKey({
        runtimeConfig: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: "runtime-key", // Pragma: allowlist secret
                  },
                },
              },
            },
          },
        },
        sourceConfig: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: "source-key", // Pragma: allowlist secret
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe("runtime-key");

    expect(
      resolveXaiToolApiKey({
        sourceConfig: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: "source-key", // Pragma: allowlist secret
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe("source-key");

    expect(resolveXaiToolApiKey({})).toBe("env-key");
  });

  it("honors explicit disabled flags before auth fallback", () => {
    vi.stubEnv("XAI_API_KEY", "env-key");
    expect(isXaiToolEnabled({ enabled: false })).toBe(false);
    expect(isXaiToolEnabled({ enabled: true })).toBe(true);
  });
});
