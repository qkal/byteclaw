import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-codex-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

function runWrappedPayloadCase(params: {
  wrap: NonNullable<ReturnType<typeof buildOpenAIProvider>["wrapStreamFn"]>;
  provider: string;
  modelId: string;
  model:
    | Model<"openai-responses">
    | Model<"openai-codex-responses">
    | Model<"azure-openai-responses">;
  extraParams?: Record<string, unknown>;
  cfg?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}) {
  const payload = params.payload ?? { store: false };
  let capturedOptions: (SimpleStreamOptions & { openaiWsWarmup?: boolean }) | undefined;
  const baseStreamFn: StreamFn = (model, _context, options) => {
    capturedOptions = options as (SimpleStreamOptions & { openaiWsWarmup?: boolean }) | undefined;
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };

  const streamFn = params.wrap({
    agentDir: "/tmp/openai-provider-test",
    config: params.cfg as never,
    extraParams: params.extraParams,
    modelId: params.modelId,
    provider: params.provider,
    streamFn: baseStreamFn,
  } as never);

  const context: Context = { messages: [] };
  void streamFn?.(params.model, context, {});

  return {
    options: capturedOptions,
    payload,
  };
}

describe("buildOpenAIProvider", () => {
  it("resolves gpt-5.4 mini and nano from GPT-5 small-model templates", () => {
    const provider = buildOpenAIProvider();
    const registry = {
      find(providerId: string, id: string) {
        if (providerId !== "openai") {
          return null;
        }
        if (id === "gpt-5-mini") {
          return {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            contextWindow: 400_000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 1, output: 2 },
            id,
            input: ["text", "image"],
            maxTokens: 128_000,
            name: "GPT-5 mini",
            provider: "openai",
            reasoning: true,
          };
        }
        if (id === "gpt-5-nano") {
          return {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            contextWindow: 200_000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0.5, output: 1 },
            id,
            input: ["text", "image"],
            maxTokens: 64_000,
            name: "GPT-5 nano",
            provider: "openai",
            reasoning: true,
          };
        }
        return null;
      },
    };

    const mini = provider.resolveDynamicModel?.({
      modelId: "gpt-5.4-mini",
      modelRegistry: registry as never,
      provider: "openai",
    });
    const nano = provider.resolveDynamicModel?.({
      modelId: "gpt-5.4-nano",
      modelRegistry: registry as never,
      provider: "openai",
    });

    expect(mini).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      id: "gpt-5.4-mini",
      maxTokens: 128_000,
      provider: "openai",
    });
    expect(nano).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      id: "gpt-5.4-nano",
      maxTokens: 128_000,
      provider: "openai",
    });
  });

  it("surfaces gpt-5.4 mini and nano in xhigh and augmented catalog metadata", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.supportsXHighThinking?.({
        modelId: "gpt-5.4-mini",
        provider: "openai",
      } as never),
    ).toBe(true);
    expect(
      provider.supportsXHighThinking?.({
        modelId: "gpt-5.4-nano",
        provider: "openai",
      } as never),
    ).toBe(true);

    const entries = provider.augmentModelCatalog?.({
      entries: [
        { id: "gpt-5-mini", name: "GPT-5 mini", provider: "openai" },
        { id: "gpt-5-nano", name: "GPT-5 nano", provider: "openai" },
      ],
      env: process.env,
    } as never);

    expect(entries).toContainEqual(
      expect.objectContaining({
        contextWindow: 400_000,
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        name: "gpt-5.4-mini",
        provider: "openai",
        reasoning: true,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        contextWindow: 400_000,
        id: "gpt-5.4-nano",
        input: ["text", "image"],
        name: "gpt-5.4-nano",
        provider: "openai",
        reasoning: true,
      }),
    );
  });

  it("owns native reasoning output mode for OpenAI and Azure OpenAI responses", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.resolveReasoningOutputMode?.({
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
        provider: "openai",
      } as never),
    ).toBe("native");
    expect(
      provider.resolveReasoningOutputMode?.({
        modelApi: "azure-openai-responses",
        modelId: "gpt-5.4",
        provider: "azure-openai-responses",
      } as never),
    ).toBe("native");
  });

  it("keeps GPT-5.4 family metadata aligned with native OpenAI docs", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAICodexProviderPlugin();

    const openaiModel = provider.resolveDynamicModel?.({
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      provider: "openai",
    } as never);
    const codexModel = codexProvider.resolveDynamicModel?.({
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      provider: "openai-codex",
    } as never);

    expect(openaiModel).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      id: "gpt-5.4",
      maxTokens: 128_000,
      provider: "openai",
    });
    expect(codexModel).toMatchObject({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 1_050_000,
      id: "gpt-5.4",
      maxTokens: 128_000,
      provider: "openai-codex",
    });
  });

  it("keeps modern live selection on OpenAI 5.2+ and Codex 5.2+", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAICodexProviderPlugin();

    expect(
      provider.isModernModelRef?.({
        modelId: "gpt-5.0",
        provider: "openai",
      } as never),
    ).toBe(false);
    expect(
      provider.isModernModelRef?.({
        modelId: "gpt-5.2",
        provider: "openai",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        modelId: "gpt-5.4",
        provider: "openai",
      } as never),
    ).toBe(true);

    expect(
      codexProvider.isModernModelRef?.({
        modelId: "gpt-5.1-codex",
        provider: "openai-codex",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        modelId: "gpt-5.1-codex-max",
        provider: "openai-codex",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        modelId: "gpt-5.2-codex",
        provider: "openai-codex",
      } as never),
    ).toBe(true);
    expect(
      codexProvider.isModernModelRef?.({
        modelId: "gpt-5.4",
        provider: "openai-codex",
      } as never),
    ).toBe(true);
  });

  it("owns replay policy for OpenAI and Codex transports", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAICodexProviderPlugin();

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai",
        modelId: "gpt-5.4",
        provider: "openai",
      } as never),
    ).toEqual({
      applyAssistantFirstOrderingFix: false,
      sanitizeMode: "images-only",
      sanitizeToolCallIds: false,
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    });

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "gpt-5.4",
        provider: "openai",
      } as never),
    ).toEqual({
      applyAssistantFirstOrderingFix: false,
      sanitizeMode: "images-only",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    });

    expect(
      codexProvider.buildReplayPolicy?.({
        modelApi: "openai-codex-responses",
        modelId: "gpt-5.4",
        provider: "openai-codex",
      } as never),
    ).toEqual({
      applyAssistantFirstOrderingFix: false,
      sanitizeMode: "images-only",
      sanitizeToolCallIds: false,
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    });
  });

  it("owns direct OpenAI wrapper composition for responses payloads", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }
    const extraParams = provider.prepareExtraParams?.({
      extraParams: {
        fastMode: true,
        serviceTier: "priority",
        textVerbosity: "low",
      },
      modelId: "gpt-5.4",
      provider: "openai",
    } as never);
    const result = runWrappedPayloadCase({
      extraParams: extraParams ?? undefined,
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as Model<"openai-responses">,
      modelId: "gpt-5.4",
      payload: {
        reasoning: { effort: "none" },
      },
      provider: "openai",
      wrap,
    });

    expect(extraParams).toMatchObject({
      openaiWsWarmup: true,
      transport: "auto",
    });
    expect(result.payload.service_tier).toBe("priority");
    expect(result.payload.text).toEqual({ verbosity: "low" });
    expect(result.payload.reasoning).toEqual({ effort: "none" });
  });

  it("owns Azure OpenAI reasoning compatibility without forcing OpenAI transport defaults", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected Azure OpenAI wrapper");
    }
    const result = runWrappedPayloadCase({
      model: {
        api: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        id: "gpt-5.4",
        provider: "azure-openai-responses",
      } as Model<"azure-openai-responses">,
      modelId: "gpt-5.4",
      payload: {
        reasoning: { effort: "none" },
      },
      provider: "azure-openai-responses",
      wrap,
    });

    expect(result.options?.transport).toBeUndefined();
    expect(result.options?.openaiWsWarmup).toBeUndefined();
    expect(result.payload.reasoning).toEqual({ effort: "none" });
  });

  it("owns Codex wrapper composition for responses payloads", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected Codex wrapper");
    }
    const result = runWrappedPayloadCase({
      cfg: {
        auth: {
          profiles: {
            "openai-codex:default": {
              mode: "oauth",
              provider: "openai-codex",
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: {
                allowedDomains: ["example.com"],
                enabled: true,
                mode: "live",
              },
            },
          },
        },
      },
      extraParams: {
        fastMode: true,
        serviceTier: "priority",
        text_verbosity: "high",
      },
      model: {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        id: "gpt-5.4",
        provider: "openai-codex",
      } as Model<"openai-codex-responses">,
      modelId: "gpt-5.4",
      payload: {
        store: false,
        text: { verbosity: "medium" },
        tools: [{ name: "read", type: "function" }],
      },
      provider: "openai-codex",
      wrap,
    });

    expect(result.payload.store).toBe(false);
    expect(result.payload.service_tier).toBe("priority");
    expect(result.payload.text).toEqual({ verbosity: "high" });
    expect(result.payload.tools).toEqual([
      { name: "read", type: "function" },
      {
        external_web_access: true,
        filters: { allowed_domains: ["example.com"] },
        type: "web_search",
      },
    ]);
  });
  it("falls back to cached codex oauth credentials on accountId extraction failures", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      access: "cached-access-token",
      expires: Date.now() - 60_000,
      provider: "openai-codex",
      refresh: "refresh-token",
      type: "oauth" as const,
    };

    refreshOpenAICodexTokenMock.mockReset();
    refreshOpenAICodexTokenMock.mockRejectedValueOnce(
      new Error("Failed to extract accountId from token"),
    );

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
  });
});
