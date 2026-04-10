import { describe, expect, it } from "vitest";
import {
  buildAnthropicReplayPolicyForModel,
  buildGoogleGeminiReplayPolicy,
  buildHybridAnthropicOrOpenAIReplayPolicy,
  buildNativeAnthropicReplayPolicyForModel,
  buildOpenAICompatibleReplayPolicy,
  buildPassthroughGeminiSanitizingReplayPolicy,
  buildStrictAnthropicReplayPolicy,
  resolveTaggedReasoningOutputMode,
  sanitizeGoogleGeminiReplayHistory,
} from "./provider-replay-helpers.js";

describe("provider replay helpers", () => {
  it("builds strict openai-completions replay policy", () => {
    expect(buildOpenAICompatibleReplayPolicy("openai-completions")).toMatchObject({
      applyAssistantFirstOrderingFix: true,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
      validateGeminiTurns: true,
    });
  });

  it("builds strict anthropic replay policy", () => {
    expect(buildStrictAnthropicReplayPolicy({ dropThinkingBlocks: true })).toMatchObject({
      allowSyntheticToolResults: true,
      dropThinkingBlocks: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      sanitizeMode: "full",
    });
  });

  it("derives claude-only anthropic replay policy from the model id", () => {
    // Sonnet 4.6 preserves thinking blocks (no drop)
    expect(buildAnthropicReplayPolicyForModel("claude-sonnet-4-6")).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
    });
    expect(buildAnthropicReplayPolicyForModel("claude-sonnet-4-6")).not.toHaveProperty(
      "dropThinkingBlocks",
    );
    // Legacy models still drop thinking blocks
    expect(buildAnthropicReplayPolicyForModel("claude-3-7-sonnet-20250219")).toMatchObject({
      dropThinkingBlocks: true,
    });
    expect(buildAnthropicReplayPolicyForModel("amazon.nova-pro-v1")).not.toHaveProperty(
      "dropThinkingBlocks",
    );
  });

  it("preserves thinking blocks for Claude Opus 4.5+ and Sonnet 4.5+ models", () => {
    // These models should NOT drop thinking blocks
    for (const modelId of [
      "claude-opus-4-5-20251101",
      "claude-opus-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]) {
      const policy = buildAnthropicReplayPolicyForModel(modelId);
      expect(policy).not.toHaveProperty("dropThinkingBlocks");
    }

    // These legacy models SHOULD drop thinking blocks
    for (const modelId of ["claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20240620"]) {
      const policy = buildAnthropicReplayPolicyForModel(modelId);
      expect(policy).toMatchObject({ dropThinkingBlocks: true });
    }
  });

  it("builds native Anthropic replay policy with selective tool-call id preservation", () => {
    // Sonnet 4.6 preserves thinking blocks
    const policy46 = buildNativeAnthropicReplayPolicyForModel("claude-sonnet-4-6");
    expect(policy46).toMatchObject({
      allowSyntheticToolResults: true,
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
    });
    expect(policy46).not.toHaveProperty("dropThinkingBlocks");

    // Legacy model drops thinking blocks
    expect(buildNativeAnthropicReplayPolicyForModel("claude-3-7-sonnet-20250219")).toMatchObject({
      dropThinkingBlocks: true,
    });
  });

  it("builds hybrid anthropic or openai replay policy", () => {
    // Sonnet 4.6 preserves thinking blocks even when flag is set
    const sonnet46Policy = buildHybridAnthropicOrOpenAIReplayPolicy(
      {
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
        provider: "minimax",
      } as never,
      { anthropicModelDropThinkingBlocks: true },
    );
    expect(sonnet46Policy).toMatchObject({
      validateAnthropicTurns: true,
    });
    expect(sonnet46Policy).not.toHaveProperty("dropThinkingBlocks");

    // Legacy model still drops
    expect(
      buildHybridAnthropicOrOpenAIReplayPolicy(
        {
          modelApi: "anthropic-messages",
          modelId: "claude-3-7-sonnet-20250219",
          provider: "minimax",
        } as never,
        { anthropicModelDropThinkingBlocks: true },
      ),
    ).toMatchObject({
      dropThinkingBlocks: true,
      validateAnthropicTurns: true,
    });

    expect(
      buildHybridAnthropicOrOpenAIReplayPolicy({
        modelApi: "openai-completions",
        modelId: "MiniMax-M2.7",
        provider: "minimax",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: true,
      sanitizeToolCallIds: true,
    });
  });

  it("builds Gemini replay helpers and tagged reasoning mode", () => {
    expect(buildGoogleGeminiReplayPolicy()).toMatchObject({
      allowSyntheticToolResults: true,
      validateGeminiTurns: true,
    });
    expect(resolveTaggedReasoningOutputMode()).toBe("tagged");
  });

  it("builds passthrough Gemini signature sanitization only when needed", () => {
    expect(buildPassthroughGeminiSanitizingReplayPolicy("gemini-2.5-pro")).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    });
    expect(
      buildPassthroughGeminiSanitizingReplayPolicy("anthropic/claude-sonnet-4-6"),
    ).not.toHaveProperty("sanitizeThoughtSignatures");
  });

  it("sanitizes Gemini replay ordering with a bootstrap turn", () => {
    const customEntries: { customType: string; data: unknown }[] = [];

    const result = sanitizeGoogleGeminiReplayHistory({
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
        appendCustomEntry: (customType: string, data: unknown) => {
          customEntries.push({ customType, data });
        },
        getCustomEntries: () => customEntries,
      },
    } as never);

    expect(result[0]).toMatchObject({
      content: "(session bootstrap)",
      role: "user",
    });
    expect(customEntries[0]?.customType).toBe("google-turn-ordering-bootstrap");
  });
});
