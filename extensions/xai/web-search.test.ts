import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { withEnv } from "openclaw/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import { resolveFallbackXaiAuth } from "./src/tool-auth-shared.js";
import { __testing, createXaiWebSearchProvider } from "./web-search.js";

const {
  extractXaiWebSearchContent,
  resolveXaiInlineCitations,
  resolveXaiToolSearchConfig,
  resolveXaiWebSearchCredential,
  resolveXaiWebSearchModel,
} = __testing;

describe("xai web search config resolution", () => {
  it("prefers configured api keys and resolves grok scoped defaults", () => {
    expect(resolveXaiWebSearchCredential({ grok: { apiKey: "xai-secret" } })).toBe("xai-secret");
    expect(resolveXaiWebSearchModel()).toBe("grok-4-1-fast");
    expect(resolveXaiInlineCitations()).toBe(false);
  });

  it("uses config apiKey when provided", () => {
    expect(resolveXaiWebSearchCredential({ grok: { apiKey: "xai-test-key" } })).toBe(
      "xai-test-key",
    );
  });

  it("returns undefined when no apiKey is available", () => {
    withEnv({ XAI_API_KEY: undefined }, () => {
      expect(resolveXaiWebSearchCredential({})).toBeUndefined();
    });
  });

  it("resolves env SecretRefs without requiring a runtime snapshot", () => {
    withEnv({ XAI_WEB_SEARCH_KEY: "xai-env-ref-key" }, () => {
      expect(
        resolveXaiWebSearchCredential({
          grok: {
            apiKey: {
              id: "XAI_WEB_SEARCH_KEY",
              provider: "default",
              source: "env",
            },
          },
        }),
      ).toBe("xai-env-ref-key");
    });
  });

  it("merges canonical plugin config into the tool search config", () => {
    const searchConfig = resolveXaiToolSearchConfig({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "plugin-key",
                  inlineCitations: true,
                  model: "grok-4-fast-reasoning",
                },
              },
              enabled: true,
            },
          },
        },
      },
      searchConfig: { provider: "grok" },
    });

    expect(resolveXaiWebSearchCredential(searchConfig)).toBe("plugin-key");
    expect(resolveXaiInlineCitations(searchConfig)).toBe(true);
    expect(resolveXaiWebSearchModel(searchConfig)).toBe("grok-4-fast");
  });

  it("treats unresolved non-env SecretRefs as missing credentials instead of throwing", async () => {
    await withEnv({ XAI_API_KEY: undefined }, async () => {
      const provider = createXaiWebSearchProvider();
      const maybeTool = provider.createTool({
        config: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: {
                      id: "/providers/xai/web-search",
                      provider: "vault",
                      source: "file",
                    },
                  },
                },
                enabled: true,
              },
            },
          },
        },
      });
      expect(maybeTool).toBeTruthy();
      if (!maybeTool) {
        throw new Error("expected xai web search tool");
      }

      await expect(maybeTool.execute({ query: "OpenClaw" })).resolves.toMatchObject({
        error: "missing_xai_api_key",
      });
    });
  });

  it("offers plugin-owned xSearch setup after Grok is selected", async () => {
    const provider = createXaiWebSearchProvider();
    const select = vi.fn().mockResolvedValueOnce("yes").mockResolvedValueOnce("grok-4-1-fast");
    const prompter = createWizardPrompter({
      select: select as never,
    });

    const next = await provider.runSetup?.({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-test-key",
                },
              },
              enabled: true,
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "grok",
            },
          },
        },
      },
      prompter,
      runtime: createNonExitingRuntime(),
    });

    expect(next?.plugins?.entries?.xai?.config?.xSearch).toMatchObject({
      enabled: true,
      model: "grok-4-1-fast",
    });
  });

  it("keeps explicit xSearch disablement untouched during provider-owned setup", async () => {
    const provider = createXaiWebSearchProvider();
    const config = {
      plugins: {
        entries: {
          xai: {
            config: {
              xSearch: {
                enabled: false,
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "grok",
          },
        },
      },
    };
    const prompter = createWizardPrompter({});

    const next = await provider.runSetup?.({
      config,
      prompter,
      runtime: createNonExitingRuntime(),
    });

    expect(next).toEqual(config);
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it("reuses the plugin web search api key for provider auth fallback", () => {
    expect(
      resolveFallbackXaiAuth({
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-provider-fallback", // Pragma: allowlist secret
                },
              },
            },
          },
        },
      } as never),
    ).toEqual({
      apiKey: "xai-provider-fallback",
      source: "plugins.entries.xai.config.webSearch.apiKey",
    });
  });

  it("reuses the legacy grok web search api key for provider auth fallback", () => {
    expect(
      resolveFallbackXaiAuth({
        tools: {
          web: {
            search: {
              grok: {
                apiKey: "xai-legacy-fallback", // Pragma: allowlist secret
              },
            },
          },
        },
      } as never),
    ).toEqual({
      apiKey: "xai-legacy-fallback",
      source: "tools.web.search.grok.apiKey",
    });
  });

  it("returns a managed marker for SecretRef-backed plugin auth fallback", () => {
    expect(
      resolveFallbackXaiAuth({
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: { id: "/xai/api-key", provider: "vault", source: "file" },
                },
              },
            },
          },
        },
      } as never),
    ).toEqual({
      apiKey: NON_ENV_SECRETREF_MARKER,
      source: "plugins.entries.xai.config.webSearch.apiKey",
    });
  });

  it("uses default model when not specified", () => {
    expect(resolveXaiWebSearchModel({})).toBe("grok-4-1-fast");
    expect(resolveXaiWebSearchModel(undefined)).toBe("grok-4-1-fast");
  });

  it("uses config model when provided", () => {
    expect(resolveXaiWebSearchModel({ grok: { model: "grok-4-fast-reasoning" } })).toBe(
      "grok-4-fast",
    );
  });

  it("normalizes deprecated grok 4.20 beta model ids to GA ids", () => {
    expect(
      resolveXaiWebSearchModel({
        grok: { model: "grok-4.20-experimental-beta-0304-reasoning" },
      }),
    ).toBe("grok-4.20-beta-latest-reasoning");
    expect(
      resolveXaiWebSearchModel({
        grok: { model: "grok-4.20-experimental-beta-0304-non-reasoning" },
      }),
    ).toBe("grok-4.20-beta-latest-non-reasoning");
  });

  it("defaults inlineCitations to false", () => {
    expect(resolveXaiInlineCitations({})).toBe(false);
    expect(resolveXaiInlineCitations(undefined)).toBe(false);
  });

  it("respects inlineCitations config", () => {
    expect(resolveXaiInlineCitations({ grok: { inlineCitations: true } })).toBe(true);
    expect(resolveXaiInlineCitations({ grok: { inlineCitations: false } })).toBe(false);
  });

  it("builds wrapped payloads with optional inline citations", () => {
    expect(
      __testing.buildXaiWebSearchPayload({
        citations: ["https://a.test"],
        content: "body",
        model: "grok-4-fast",
        provider: "grok",
        query: "q",
        tookMs: 12,
      }),
    ).toMatchObject({
      citations: ["https://a.test"],
      externalContent: expect.objectContaining({ wrapped: true }),
      model: "grok-4-fast",
      provider: "grok",
      query: "q",
      tookMs: 12,
    });
  });
});

describe("xai web search response parsing", () => {
  it("extracts content from Responses API message blocks", () => {
    const result = extractXaiWebSearchContent({
      output: [
        {
          content: [{ text: "hello from output", type: "output_text" }],
          type: "message",
        },
      ],
    });
    expect(result.text).toBe("hello from output");
    expect(result.annotationCitations).toEqual([]);
  });

  it("extracts url_citation annotations from content blocks", () => {
    const result = extractXaiWebSearchContent({
      output: [
        {
          content: [
            {
              annotations: [
                { type: "url_citation", url: "https://example.com/a" },
                { type: "url_citation", url: "https://example.com/b" },
                { type: "url_citation", url: "https://example.com/a" },
              ],
              text: "hello with citations",
              type: "output_text",
            },
          ],
          type: "message",
        },
      ],
    });
    expect(result.text).toBe("hello with citations");
    expect(result.annotationCitations).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("falls back to deprecated output_text", () => {
    const result = extractXaiWebSearchContent({ output_text: "hello from output_text" });
    expect(result.text).toBe("hello from output_text");
    expect(result.annotationCitations).toEqual([]);
  });

  it("returns undefined text when no content found", () => {
    const result = extractXaiWebSearchContent({});
    expect(result.text).toBeUndefined();
    expect(result.annotationCitations).toEqual([]);
  });

  it("extracts output_text blocks directly in output array", () => {
    const result = extractXaiWebSearchContent({
      output: [
        { type: "web_search_call" },
        {
          annotations: [{ type: "url_citation", url: "https://example.com/direct" }],
          text: "direct output text",
          type: "output_text",
        },
      ],
    });
    expect(result.text).toBe("direct output text");
    expect(result.annotationCitations).toEqual(["https://example.com/direct"]);
  });
});

describe("xai provider models", () => {
  it("publishes the newer Grok fast and code models in the bundled catalog", () => {
    expect(resolveXaiCatalogEntry("grok-4-1-fast")).toMatchObject({
      contextWindow: 2_000_000,
      id: "grok-4-1-fast",
      input: ["text", "image"],
      maxTokens: 30_000,
      reasoning: true,
    });
    expect(resolveXaiCatalogEntry("grok-code-fast-1")).toMatchObject({
      contextWindow: 256_000,
      id: "grok-code-fast-1",
      maxTokens: 10_000,
      reasoning: true,
    });
  });

  it("publishes Grok 4.20 reasoning and non-reasoning models", () => {
    expect(resolveXaiCatalogEntry("grok-4.20-beta-latest-reasoning")).toMatchObject({
      contextWindow: 2_000_000,
      id: "grok-4.20-beta-latest-reasoning",
      input: ["text", "image"],
      reasoning: true,
    });
    expect(resolveXaiCatalogEntry("grok-4.20-beta-latest-non-reasoning")).toMatchObject({
      contextWindow: 2_000_000,
      id: "grok-4.20-beta-latest-non-reasoning",
      reasoning: false,
    });
  });

  it("keeps older Grok aliases resolving with current limits", () => {
    expect(resolveXaiCatalogEntry("grok-4-1-fast-reasoning")).toMatchObject({
      contextWindow: 2_000_000,
      id: "grok-4-1-fast-reasoning",
      maxTokens: 30_000,
      reasoning: true,
    });
    expect(resolveXaiCatalogEntry("grok-4.20-reasoning")).toMatchObject({
      contextWindow: 2_000_000,
      id: "grok-4.20-reasoning",
      maxTokens: 30_000,
      reasoning: true,
    });
  });

  it("publishes the remaining Grok 3 family that Pi still carries", () => {
    expect(resolveXaiCatalogEntry("grok-3-mini-fast")).toMatchObject({
      contextWindow: 131_072,
      id: "grok-3-mini-fast",
      maxTokens: 8192,
      reasoning: true,
    });
    expect(resolveXaiCatalogEntry("grok-3-fast")).toMatchObject({
      contextWindow: 131_072,
      id: "grok-3-fast",
      maxTokens: 8192,
      reasoning: false,
    });
  });

  it("marks current Grok families as modern while excluding multi-agent ids", () => {
    expect(isModernXaiModel("grok-4.20-beta-latest-reasoning")).toBe(true);
    expect(isModernXaiModel("grok-code-fast-1")).toBe(true);
    expect(isModernXaiModel("grok-3-mini-fast")).toBe(true);
    expect(isModernXaiModel("grok-4.20-multi-agent-experimental-beta-0304")).toBe(false);
  });

  it("builds forward-compatible runtime models for newer Grok ids", () => {
    const grok41 = resolveXaiForwardCompatModel({
      ctx: {
        modelId: "grok-4-1-fast",
        modelRegistry: { find: () => null } as never,
        provider: "xai",
        providerConfig: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
        },
      },
      providerId: "xai",
    });
    const grok420 = resolveXaiForwardCompatModel({
      ctx: {
        modelId: "grok-4.20-beta-latest-reasoning",
        modelRegistry: { find: () => null } as never,
        provider: "xai",
        providerConfig: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
        },
      },
      providerId: "xai",
    });
    const grok3Mini = resolveXaiForwardCompatModel({
      ctx: {
        modelId: "grok-3-mini-fast",
        modelRegistry: { find: () => null } as never,
        provider: "xai",
        providerConfig: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
        },
      },
      providerId: "xai",
    });

    expect(grok41).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      contextWindow: 2_000_000,
      id: "grok-4-1-fast",
      maxTokens: 30_000,
      provider: "xai",
      reasoning: true,
    });
    expect(grok420).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      contextWindow: 2_000_000,
      id: "grok-4.20-beta-latest-reasoning",
      input: ["text", "image"],
      maxTokens: 30_000,
      provider: "xai",
      reasoning: true,
    });
    expect(grok3Mini).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      contextWindow: 131_072,
      id: "grok-3-mini-fast",
      maxTokens: 8192,
      provider: "xai",
      reasoning: true,
    });
  });

  it("refuses the unsupported multi-agent endpoint ids", () => {
    const model = resolveXaiForwardCompatModel({
      ctx: {
        modelId: "grok-4.20-multi-agent-experimental-beta-0304",
        modelRegistry: { find: () => null } as never,
        provider: "xai",
        providerConfig: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
        },
      },
      providerId: "xai",
    });

    expect(model).toBeUndefined();
  });
});
