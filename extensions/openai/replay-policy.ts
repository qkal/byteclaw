import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";

/**
 * Returns the provider-owned replay policy for OpenAI-family transports.
 */
export function buildOpenAIReplayPolicy(ctx: ProviderReplayPolicyContext): ProviderReplayPolicy {
  return {
    applyAssistantFirstOrderingFix: false,
    sanitizeMode: "images-only",
    validateAnthropicTurns: false,
    validateGeminiTurns: false,
    ...(ctx.modelApi === "openai-completions"
      ? {
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict" as const,
        }
      : {
          sanitizeToolCallIds: false,
        }),
  };
}
