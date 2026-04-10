import { describe, expect, it } from "vitest";
import {
  buildCodexNativeWebSearchTool,
  describeCodexNativeWebSearch,
  patchCodexNativeWebSearchPayload,
  resolveCodexNativeSearchActivation,
  resolveCodexNativeWebSearchConfig,
  shouldSuppressManagedWebSearchTool,
} from "./codex-native-web-search.js";

const baseConfig = {
  tools: {
    web: {
      search: {
        enabled: true,
        openaiCodex: {
          enabled: true,
          mode: "cached",
        },
      },
    },
  },
} as const;

describe("resolveCodexNativeSearchActivation", () => {
  it("returns managed_only when native Codex search is disabled", () => {
    const result = resolveCodexNativeSearchActivation({
      config: { tools: { web: { search: { enabled: true } } } },
      modelApi: "openai-codex-responses",
      modelProvider: "openai-codex",
    });

    expect(result.state).toBe("managed_only");
    expect(result.inactiveReason).toBe("codex_not_enabled");
  });

  it("returns managed_only for non-eligible models", () => {
    const result = resolveCodexNativeSearchActivation({
      config: baseConfig,
      modelApi: "openai-responses",
      modelProvider: "openai",
    });

    expect(result.state).toBe("managed_only");
    expect(result.inactiveReason).toBe("model_not_eligible");
  });

  it("activates for direct openai-codex when auth exists", () => {
    const result = resolveCodexNativeSearchActivation({
      config: {
        ...baseConfig,
        auth: {
          profiles: {
            "openai-codex:default": {
              mode: "oauth",
              provider: "openai-codex",
            },
          },
        },
      },
      modelApi: "openai-codex-responses",
      modelProvider: "openai-codex",
    });

    expect(result.state).toBe("native_active");
    expect(result.codexMode).toBe("cached");
  });

  it("falls back to managed_only when direct openai-codex auth is missing", () => {
    const result = resolveCodexNativeSearchActivation({
      config: baseConfig,
      modelApi: "openai-codex-responses",
      modelProvider: "openai-codex",
    });

    expect(result.state).toBe("managed_only");
    expect(result.inactiveReason).toBe("codex_auth_missing");
  });

  it("activates for api-compatible openai-codex-responses providers without separate Codex auth", () => {
    const result = resolveCodexNativeSearchActivation({
      config: baseConfig,
      modelApi: "openai-codex-responses",
      modelProvider: "gateway",
    });

    expect(result.state).toBe("native_active");
  });

  it("keeps all search disabled when global web search is disabled", () => {
    const result = resolveCodexNativeSearchActivation({
      config: {
        tools: {
          web: {
            search: {
              enabled: false,
              openaiCodex: { enabled: true, mode: "live" },
            },
          },
        },
      },
      modelApi: "openai-codex-responses",
      modelProvider: "openai-codex",
    });

    expect(result.state).toBe("managed_only");
    expect(result.inactiveReason).toBe("globally_disabled");
  });
});

describe("Codex native web-search payload helpers", () => {
  it("omits the summary when global web search is disabled", () => {
    expect(
      describeCodexNativeWebSearch({
        tools: {
          web: {
            search: {
              enabled: false,
              openaiCodex: {
                enabled: true,
                mode: "live",
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("normalizes optional config values", () => {
    const result = resolveCodexNativeWebSearchConfig({
      tools: {
        web: {
          search: {
            openaiCodex: {
              allowedDomains: [" example.com ", "example.com", ""],
              contextSize: "high",
              enabled: true,
              userLocation: {
                city: " New York ",
                country: " US ",
                timezone: "America/New_York",
              },
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      allowedDomains: ["example.com"],
      contextSize: "high",
      enabled: true,
      mode: "cached",
      userLocation: {
        city: "New York",
        country: "US",
        timezone: "America/New_York",
      },
    });
  });

  it("builds the native Responses web_search tool", () => {
    expect(
      buildCodexNativeWebSearchTool({
        tools: {
          web: {
            search: {
              openaiCodex: {
                allowedDomains: ["example.com"],
                contextSize: "medium",
                enabled: true,
                mode: "live",
                userLocation: { country: "US" },
              },
            },
          },
        },
      }),
    ).toEqual({
      external_web_access: true,
      filters: { allowed_domains: ["example.com"] },
      search_context_size: "medium",
      type: "web_search",
      user_location: {
        country: "US",
        type: "approximate",
      },
    });
  });

  it("injects native web_search into provider payloads", () => {
    const payload: Record<string, unknown> = { tools: [{ name: "read", type: "function" }] };
    const result = patchCodexNativeWebSearchPayload({ config: baseConfig, payload });

    expect(result.status).toBe("injected");
    expect(payload.tools).toEqual([
      { name: "read", type: "function" },
      { external_web_access: false, type: "web_search" },
    ]);
  });

  it("does not inject a duplicate native web_search tool", () => {
    const payload: Record<string, unknown> = { tools: [{ type: "web_search" }] };
    const result = patchCodexNativeWebSearchPayload({ config: baseConfig, payload });

    expect(result.status).toBe("native_tool_already_present");
    expect(payload.tools).toEqual([{ type: "web_search" }]);
  });
});

describe("shouldSuppressManagedWebSearchTool", () => {
  it("suppresses managed web_search only when native Codex search is active", () => {
    expect(
      shouldSuppressManagedWebSearchTool({
        config: baseConfig,
        modelApi: "openai-codex-responses",
        modelProvider: "gateway",
      }),
    ).toBe(true);

    expect(
      shouldSuppressManagedWebSearchTool({
        config: baseConfig,
        modelApi: "openai-responses",
        modelProvider: "openai",
      }),
    ).toBe(false);
  });
});

describe("isCodexNativeWebSearchRelevant", () => {
  it("treats a default model with model-level openai-codex-responses api as relevant", async () => {
    const { isCodexNativeWebSearchRelevant } = await import("./codex-native-web-search.js");

    expect(
      isCodexNativeWebSearchRelevant({
        config: {
          agents: {
            defaults: {
              model: {
                primary: "gateway/gpt-5.4",
              },
            },
          },
          models: {
            providers: {
              gateway: {
                api: "openai-responses",
                baseUrl: "https://gateway.example/v1",
                models: [
                  {
                    api: "openai-codex-responses",
                    contextWindow: 128_000,
                    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                    id: "gpt-5.4",
                    input: ["text"],
                    maxTokens: 16_384,
                    name: "gpt-5.4",
                    reasoning: false,
                  },
                ],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });
});
