import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resetProviderRuntimeHookCacheForTest: vi.fn(),
    resolveProviderRuntimePlugin: vi.fn(({ provider }: { provider?: string }) => {
      if (
        !provider ||
        ![
          "amazon-bedrock",
          "anthropic",
          "google",
          "kilocode",
          "kimi",
          "kimi-code",
          "minimax",
          "minimax-portal",
          "mistral",
          "moonshot",
          "openai",
          "openai-codex",
          "opencode",
          "opencode-go",
          "ollama",
          "openrouter",
          "sglang",
          "vllm",
          "xai",
          "zai",
        ].includes(provider)
      ) {
        return undefined;
      }
      if (provider === "sglang" || provider === "vllm") {
        return {};
      }
      return {
        buildReplayPolicy: (context?: { modelId?: string; modelApi?: string }) => {
          const modelId = context?.modelId?.toLowerCase() ?? "";
          switch (provider) {
            case "amazon-bedrock":
            case "anthropic": {
              return {
                sanitizeMode: "full",
                sanitizeToolCallIds: true,
                toolCallIdMode: "strict",
                preserveSignatures: true,
                repairToolUseResultPairing: true,
                validateAnthropicTurns: true,
                allowSyntheticToolResults: true,
                ...(modelId.includes("claude") ? { dropThinkingBlocks: true } : {}),
              };
            }
            case "minimax":
            case "minimax-portal": {
              return context?.modelApi === "openai-completions"
                ? {
                    sanitizeToolCallIds: true,
                    toolCallIdMode: "strict",
                    applyAssistantFirstOrderingFix: true,
                    validateGeminiTurns: true,
                    validateAnthropicTurns: true,
                  }
                : {
                    sanitizeMode: "full",
                    sanitizeToolCallIds: true,
                    toolCallIdMode: "strict",
                    preserveSignatures: true,
                    repairToolUseResultPairing: true,
                    validateAnthropicTurns: true,
                    allowSyntheticToolResults: true,
                    ...(modelId.includes("claude") ? { dropThinkingBlocks: true } : {}),
                  };
            }
            case "moonshot":
            case "ollama":
            case "zai": {
              return context?.modelApi === "openai-completions"
                ? {
                    sanitizeToolCallIds: true,
                    toolCallIdMode: "strict",
                    applyAssistantFirstOrderingFix: true,
                    validateGeminiTurns: true,
                    validateAnthropicTurns: true,
                  }
                : undefined;
            }
            case "google": {
              return {
                sanitizeMode: "full",
                sanitizeToolCallIds: true,
                toolCallIdMode: "strict",
                sanitizeThoughtSignatures: {
                  allowBase64Only: true,
                  includeCamelCase: true,
                },
                repairToolUseResultPairing: true,
                applyAssistantFirstOrderingFix: true,
                validateGeminiTurns: true,
                validateAnthropicTurns: false,
                allowSyntheticToolResults: true,
              };
            }
            case "mistral": {
              return {
                sanitizeToolCallIds: true,
                toolCallIdMode: "strict9",
              };
            }
            case "openai":
            case "openai-codex": {
              return {
                sanitizeMode: "images-only",
                sanitizeToolCallIds: context?.modelApi === "openai-completions",
                ...(context?.modelApi === "openai-completions" ? { toolCallIdMode: "strict" } : {}),
                applyAssistantFirstOrderingFix: false,
                validateGeminiTurns: false,
                validateAnthropicTurns: false,
              };
            }
            case "kimi":
            case "kimi-code": {
              return {
                preserveSignatures: false,
              };
            }
            case "openrouter":
            case "opencode":
            case "opencode-go": {
              return {
                applyAssistantFirstOrderingFix: false,
                validateGeminiTurns: false,
                validateAnthropicTurns: false,
                ...(modelId.includes("gemini")
                  ? {
                      sanitizeThoughtSignatures: {
                        allowBase64Only: true,
                        includeCamelCase: true,
                      },
                    }
                  : {}),
              };
            }
            case "xai": {
              if (
                context?.modelApi === "openai-completions" ||
                context?.modelApi === "openai-responses"
              ) {
                return {
                  sanitizeToolCallIds: true,
                  toolCallIdMode: "strict",
                  ...(context.modelApi === "openai-completions"
                    ? {
                        applyAssistantFirstOrderingFix: true,
                        validateGeminiTurns: true,
                        validateAnthropicTurns: true,
                      }
                    : {
                        applyAssistantFirstOrderingFix: false,
                        validateGeminiTurns: false,
                        validateAnthropicTurns: false,
                      }),
                };
              }
              return undefined;
            }
            case "kilocode": {
              return modelId.includes("gemini")
                ? {
                    sanitizeThoughtSignatures: {
                      allowBase64Only: true,
                      includeCamelCase: true,
                    },
                  }
                : undefined;
            }
            default: {
              return undefined;
            }
          }
        },
      };
    }),
  };
});

let resolveTranscriptPolicy: typeof import("./transcript-policy.js").resolveTranscriptPolicy;

describe("resolveTranscriptPolicy", () => {
  beforeAll(async () => {
    ({ resolveTranscriptPolicy } = await import("./transcript-policy.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables sanitizeToolCallIds for Anthropic provider", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "anthropic-messages",
      modelId: "claude-opus-4-6",
      provider: "anthropic",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
  });

  it("enables sanitizeToolCallIds for Google provider", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "google-generative-ai",
      modelId: "gemini-2.0-flash",
      provider: "google",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.sanitizeThoughtSignatures).toEqual({
      allowBase64Only: true,
      includeCamelCase: true,
    });
  });

  it("enables sanitizeToolCallIds for Mistral provider", () => {
    const policy = resolveTranscriptPolicy({
      modelId: "mistral-large-latest",
      provider: "mistral",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict9");
  });

  it("disables sanitizeToolCallIds for OpenAI provider", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai",
      modelId: "gpt-4o",
      provider: "openai",
    });
    expect(policy.sanitizeToolCallIds).toBe(false);
    expect(policy.toolCallIdMode).toBeUndefined();
    expect(policy.applyGoogleTurnOrdering).toBe(false);
    expect(policy.validateGeminiTurns).toBe(false);
    expect(policy.validateAnthropicTurns).toBe(false);
  });

  it("enables strict tool call id sanitization for openai-completions APIs", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai-completions",
      modelId: "gpt-5.4",
      provider: "openai",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
  });

  it("enables user-turn merge for strict OpenAI-compatible providers", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai-completions",
      modelId: "kimi-k2.5",
      provider: "moonshot",
    });
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("falls back to unowned transport defaults when no owning plugin exists", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai-completions",
      modelId: "demo-model",
      provider: "custom-openai-proxy",
    });

    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("preserves thinking blocks for newer Claude models in unowned Anthropic transport fallback", () => {
    // Opus 4.6 via custom proxy: should NOT drop thinking blocks
    const opus46 = resolveTranscriptPolicy({
      modelApi: "anthropic-messages",
      modelId: "claude-opus-4-6",
      provider: "custom-anthropic-proxy",
    });
    expect(opus46.dropThinkingBlocks).toBe(false);

    // Sonnet 4.5 via custom proxy: should NOT drop
    const sonnet45 = resolveTranscriptPolicy({
      modelApi: "anthropic-messages",
      modelId: "claude-sonnet-4-5-20250929",
      provider: "custom-anthropic-proxy",
    });
    expect(sonnet45.dropThinkingBlocks).toBe(false);

    // Legacy Sonnet 3.7 via custom proxy: SHOULD drop
    const sonnet37 = resolveTranscriptPolicy({
      modelApi: "anthropic-messages",
      modelId: "claude-3-7-sonnet-20250219",
      provider: "custom-anthropic-proxy",
    });
    expect(sonnet37.dropThinkingBlocks).toBe(true);
  });

  it("preserves transport defaults when a runtime plugin has not adopted replay hooks", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai-completions",
      modelId: "demo-model",
      provider: "vllm",
    });

    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("uses provider-owned Anthropic replay policy for MiniMax transports", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "anthropic-messages",
      modelId: "MiniMax-M2.7",
      provider: "minimax",
    });

    expect(policy.sanitizeMode).toBe("full");
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.preserveSignatures).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("uses provider-owned OpenAI-compatible replay policy for MiniMax portal completions", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai-completions",
      modelId: "MiniMax-M2.7",
      provider: "minimax-portal",
    });

    expect(policy.sanitizeMode).toBe("images-only");
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
    expect(policy.preserveSignatures).toBe(false);
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("enables Anthropic-compatible policies for Bedrock provider", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "bedrock-converse-stream",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      provider: "amazon-bedrock",
    });
    expect(policy.repairToolUseResultPairing).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
    expect(policy.allowSyntheticToolResults).toBe(true);
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.sanitizeMode).toBe("full");
  });

  it.each([
    {
      modelApi: "anthropic-messages" as const,
      modelId: "claude-opus-4-6",
      preserveSignatures: true,
      provider: "anthropic",
      title: "Anthropic provider",
    },
    {
      modelApi: "bedrock-converse-stream" as const,
      modelId: "us.anthropic.claude-opus-4-6-v1",
      preserveSignatures: true,
      provider: "amazon-bedrock",
      title: "Bedrock Anthropic",
    },
    {
      modelApi: "google-generative-ai" as const,
      modelId: "gemini-2.0-flash",
      preserveSignatures: false,
      provider: "google",
      title: "Google provider",
    },
    {
      modelApi: "openai" as const,
      modelId: "gpt-4o",
      preserveSignatures: false,
      provider: "openai",
      title: "OpenAI provider",
    },
    {
      modelId: "mistral-large-latest",
      preserveSignatures: false,
      provider: "mistral",
      title: "Mistral provider",
    },
    {
      modelApi: "anthropic-messages" as const,
      modelId: "kimi-code",
      preserveSignatures: false,
      provider: "kimi",
      title: "Kimi provider",
    },
    {
      modelApi: "anthropic-messages" as const,
      modelId: "kimi-code",
      preserveSignatures: false,
      provider: "kimi-code",
      title: "kimi-code alias",
    },
  ])("sets preserveSignatures for $title (#32526, #39798)", ({ preserveSignatures, ...input }) => {
    const policy = resolveTranscriptPolicy(input);
    expect(policy.preserveSignatures).toBe(preserveSignatures);
  });

  it("enables turn-ordering and assistant-merge for strict OpenAI-compatible providers (#38962)", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai-completions",
      modelId: "gemma-3-27b",
      provider: "vllm",
    });
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("keeps OpenRouter on its existing turn-validation path", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai-completions",
      modelId: "openai/gpt-4.1",
      provider: "openrouter",
    });
    expect(policy.applyGoogleTurnOrdering).toBe(false);
    expect(policy.validateGeminiTurns).toBe(false);
    expect(policy.validateAnthropicTurns).toBe(false);
  });

  it.each([
    { modelId: "google/gemini-2.5-pro-preview", provider: "openrouter" },
    { modelId: "google/gemini-2.5-flash", provider: "opencode" },
    { modelId: "gemini-2.0-flash", provider: "kilocode" },
  ])("sanitizes Gemini thought signatures for $provider routes", ({ provider, modelId }) => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai-completions",
      modelId,
      provider,
    });
    expect(policy.sanitizeThoughtSignatures).toEqual({
      allowBase64Only: true,
      includeCamelCase: true,
    });
  });
});
