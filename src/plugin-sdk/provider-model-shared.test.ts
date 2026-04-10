import { describe, expect, it } from "vitest";
import { buildProviderReplayFamilyHooks } from "./provider-model-shared.js";

describe("buildProviderReplayFamilyHooks", () => {
  it("covers the replay family matrix", async () => {
    const cases = [
      {
        ctx: {
          modelApi: "openai-completions",
          modelId: "grok-4",
          provider: "xai",
        },
        family: "openai-compatible" as const,
        hasSanitizeReplayHistory: false,
        match: {
          applyAssistantFirstOrderingFix: true,
          sanitizeToolCallIds: true,
          validateGeminiTurns: true,
        },
        reasoningMode: undefined,
      },
      {
        absent: ["dropThinkingBlocks"],
        ctx: {
          modelApi: "anthropic-messages",
          modelId: "claude-sonnet-4-6",
          provider: "anthropic-vertex",
        },
        family: "anthropic-by-model" as const,
        hasSanitizeReplayHistory: false,
        match: {
          validateAnthropicTurns: true,
          // Sonnet 4.6 preserves thinking blocks (no dropThinkingBlocks)
        },
        reasoningMode: undefined,
      },
      {
        ctx: {
          modelApi: "google-generative-ai",
          modelId: "gemini-3.1-pro-preview",
          provider: "google",
        },
        family: "google-gemini" as const,
        hasSanitizeReplayHistory: true,
        match: {
          allowSyntheticToolResults: true,
          validateGeminiTurns: true,
        },
        reasoningMode: "tagged",
      },
      {
        ctx: {
          modelApi: "openai-completions",
          modelId: "gemini-2.5-pro",
          provider: "openrouter",
        },
        family: "passthrough-gemini" as const,
        hasSanitizeReplayHistory: false,
        match: {
          applyAssistantFirstOrderingFix: false,
          sanitizeThoughtSignatures: {
            allowBase64Only: true,
            includeCamelCase: true,
          },
          validateAnthropicTurns: false,
          validateGeminiTurns: false,
        },
        reasoningMode: undefined,
      },
      {
        absent: ["dropThinkingBlocks"],
        ctx: {
          modelApi: "anthropic-messages",
          modelId: "claude-sonnet-4-6",
          provider: "minimax",
        },
        family: "hybrid-anthropic-openai" as const,
        hasSanitizeReplayHistory: false,
        match: {
          validateAnthropicTurns: true,
          // Sonnet 4.6 preserves thinking blocks even with flag set
        },
        options: {
          anthropicModelDropThinkingBlocks: true,
        },
        reasoningMode: undefined,
      },
    ];

    for (const testCase of cases) {
      const hooks = buildProviderReplayFamilyHooks(
        testCase.options
          ? {
              family: testCase.family,
              ...testCase.options,
            }
          : { family: testCase.family },
      );

      const policy = hooks.buildReplayPolicy?.(testCase.ctx as never);
      expect(policy).toMatchObject(testCase.match);
      if ((testCase as { absent?: string[] }).absent) {
        for (const key of (testCase as { absent: string[] }).absent) {
          expect(policy).not.toHaveProperty(key);
        }
      }
      expect(Boolean(hooks.sanitizeReplayHistory)).toBe(testCase.hasSanitizeReplayHistory);
      expect(hooks.resolveReasoningOutputMode?.(testCase.ctx as never)).toBe(
        testCase.reasoningMode,
      );
    }
  });

  it("keeps google-gemini replay sanitation on the bootstrap path", async () => {
    const hooks = buildProviderReplayFamilyHooks({
      family: "google-gemini",
    });

    const sanitized = await hooks.sanitizeReplayHistory?.({
      messages: [
        {
          content: [{ type: "text", text: "hello" }],
          role: "assistant",
        },
      ],
      modelApi: "google-generative-ai",
      modelId: "gemini-3.1-pro-preview",
      provider: "google",
      sessionId: "session-1",
      sessionState: {
        appendCustomEntry: () => {},
        getCustomEntries: () => [],
      },
    } as never);

    expect(sanitized?.[0]).toMatchObject({
      content: "(session bootstrap)",
      role: "user",
    });
  });

  it("keeps anthropic-by-model replay family scoped to claude ids", () => {
    const hooks = buildProviderReplayFamilyHooks({
      family: "anthropic-by-model",
    });

    expect(
      hooks.buildReplayPolicy?.({
        modelApi: "anthropic-messages",
        modelId: "amazon.nova-pro-v1",
        provider: "amazon-bedrock",
      } as never),
    ).not.toHaveProperty("dropThinkingBlocks");
  });
});
