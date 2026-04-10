import type { Message, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  completeSimpleWithLiveTimeout,
  extractAssistantText,
  logLiveCache,
} from "./live-cache-test-support.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./pi-embedded-runner/run/attempt.tool-call-normalization.js";
import { buildAssistantMessageWithZeroUsage } from "./stream-message-shared.js";

const ANTHROPIC_LIVE = isLiveTestEnabled(["ANTHROPIC_LIVE_TEST"]);
const describeLive = ANTHROPIC_LIVE ? describe : describe.skip;
const ANTHROPIC_TIMEOUT_MS = 120_000;
const TOOL_OUTPUT_SENTINEL = "TOOL-RESULT-LIVE-MAGENTA";

function buildLiveAnthropicModel(): {
  apiKey: string;
  model: Model<"anthropic-messages">;
} {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("missing ANTHROPIC_API_KEY");
  }
  const modelId =
    (process.env.OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL || "claude-sonnet-4-6")
      .split(/[/:]/)
      .filter(Boolean)
      .pop() || "claude-sonnet-4-6";
  return {
    apiKey,
    model: {
      api: "anthropic-messages" as const,
      baseUrl: "https://api.anthropic.com/v1",
      contextWindow: 200_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: modelId,
      input: ["text"] as const,
      maxTokens: 8192,
      name: modelId,
      provider: "anthropic",
      reasoning: true,
    } satisfies Model<"anthropic-messages">,
  };
}

describeLive("pi embedded anthropic replay sanitization (live)", () => {
  it(
    "preserves toolCall replay history that Anthropic accepts end-to-end",
    async () => {
      const { apiKey, model } = buildLiveAnthropicModel();
      const messages: Message[] = [
        {
          ...buildAssistantMessageWithZeroUsage({
            content: [{ arguments: {}, id: "call_1", name: "noop", type: "toolCall" }],
            model: { api: model.api, id: model.id, provider: model.provider },
            stopReason: "toolUse",
          }),
        },
        {
          content: [{ text: TOOL_OUTPUT_SENTINEL, type: "text" }],
          isError: false,
          role: "toolResult",
          timestamp: Date.now(),
          toolCallId: "call_1",
          toolName: "noop",
        },
        {
          content:
            "The tool finished. Reply with exactly OK as plain text if this replay history is valid.",
          role: "user",
          timestamp: Date.now(),
        },
      ];

      const baseFn = vi.fn((_model: unknown, context: unknown) => ({ context }));
      const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["noop"]), {
        validateAnthropicTurns: true,
        validateGeminiTurns: false,
      });

      await Promise.resolve(wrapped(model as never, { messages } as never, {} as never));

      expect(baseFn).toHaveBeenCalledTimes(1);
      const seenMessages = (baseFn.mock.calls[0]?.[1] as { messages?: unknown[] })?.messages;
      expect(seenMessages).toEqual(messages);

      logLiveCache(`anthropic replay live model=${model.provider}/${model.id}`);
      const response = await completeSimpleWithLiveTimeout(
        model,
        { messages: seenMessages as typeof messages },
        {
          apiKey,
          cacheRetention: "none",
          maxTokens: 64,
          sessionId: "anthropic-tool-replay-live",
          temperature: 0,
        },
        "anthropic replay live synthetic transcript",
        ANTHROPIC_TIMEOUT_MS,
      );

      const text = extractAssistantText(response);
      logLiveCache(`anthropic replay live result=${JSON.stringify(text)}`);
      expect(response.content.length).toBeGreaterThanOrEqual(0);
    },
    6 * 60_000,
  );
});
