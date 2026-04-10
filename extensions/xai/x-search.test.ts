import { withFetchPreconnect } from "openclaw/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXSearchTool } from "./x-search.js";

function installXSearchFetch(payload?: Record<string, unknown>) {
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve({
      json: () =>
        Promise.resolve(
          payload ?? {
            citations: ["https://x.com/openclaw/status/1"],
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Found X posts",
                    annotations: [{ type: "url_citation", url: "https://x.com/openclaw/status/1" }],
                  },
                ],
              },
            ],
          },
        ),
      ok: true,
    } as Response),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function parseFirstRequestBody(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  const requestBody = request?.body;
  return JSON.parse(typeof requestBody === "string" ? requestBody : "{}") as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("xai x_search tool", () => {
  it("enables x_search when runtime config carries the shared xAI key", () => {
    const tool = createXSearchTool({
      config: {},
      runtimeConfig: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "x-search-runtime-key", // Pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    expect(tool?.name).toBe("x_search");
  });

  it("enables x_search when the xAI plugin web search key is configured", () => {
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // Pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    expect(tool?.name).toBe("x_search");
  });

  it("uses the xAI Responses x_search tool with structured filters", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-config-test", // Pragma: allowlist secret
                },
                xSearch: {
                  maxTurns: 2,
                  model: "grok-4-1-fast-non-reasoning",
                },
              },
            },
          },
        },
      },
    });

    const result = await tool?.execute?.("x-search:1", {
      allowed_x_handles: ["openclaw"],
      enable_image_understanding: true,
      excluded_x_handles: ["spam"],
      from_date: "2026-03-01",
      query: "dinner recipes",
      to_date: "2026-03-20",
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("api.x.ai/v1/responses");
    const body = parseFirstRequestBody(mockFetch);
    expect(body.model).toBe("grok-4-1-fast-non-reasoning");
    expect(body.max_turns).toBe(2);
    expect(body.tools).toEqual([
      {
        allowed_x_handles: ["openclaw"],
        enable_image_understanding: true,
        excluded_x_handles: ["spam"],
        from_date: "2026-03-01",
        to_date: "2026-03-20",
        type: "x_search",
      },
    ]);
    expect((result?.details as { citations?: string[] } | undefined)?.citations).toEqual([
      "https://x.com/openclaw/status/1",
    ]);
  });

  it("reuses the xAI plugin web search key for x_search requests", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // Pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:plugin-key", {
      query: "latest post from huntharo",
    });

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer xai-plugin-key",
    );
  });

  it("prefers the active runtime config for shared xAI keys", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: { id: "X_SEARCH_KEY_REF", provider: "default", source: "env" },
                },
              },
            },
          },
        },
      },
      runtimeConfig: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "x-search-runtime-key", // Pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:runtime-key", {
      query: "runtime key search",
    });

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer x-search-runtime-key",
    );
  });

  it("reuses the legacy grok web search key for x_search requests", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        tools: {
          web: {
            search: {
              grok: {
                apiKey: "xai-legacy-key", // Pragma: allowlist secret
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:legacy-key", {
      query: "latest legacy-key post from huntharo",
    });

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer xai-legacy-key",
    );
  });

  it("uses migrated runtime auth when the source config still carries legacy x_search apiKey", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        tools: {
          web: {
            x_search: {
              apiKey: "legacy-x-search-key", // Pragma: allowlist secret
              enabled: true,
            } as Record<string, unknown>,
          },
        },
      },
      runtimeConfig: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "migrated-runtime-key", // Pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:migrated-runtime-key", {
      query: "migrated runtime auth",
    });

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer migrated-runtime-key",
    );
  });

  it("rejects invalid date ordering before calling xAI", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-config-test", // Pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await expect(
      tool?.execute?.("x-search:bad-dates", {
        from_date: "2026-03-20",
        query: "dinner recipes",
        to_date: "2026-03-01",
      }),
    ).rejects.toThrow(/from_date must be on or before to_date/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
