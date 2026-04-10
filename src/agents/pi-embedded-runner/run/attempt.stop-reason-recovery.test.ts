import type { StreamFn } from "@mariozechner/pi-agent-core";
import { type Context, type Model, createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt.stop-reason-recovery.js";

const anthropicModel = {
  api: "anthropic-messages",
  id: "claude-sonnet-4-6",
  provider: "anthropic",
} as Model<"anthropic-messages">;

describe("wrapStreamFnHandleSensitiveStopReason", () => {
  it("rewrites unhandled stop-reason errors into structured assistant errors", async () => {
    const baseStreamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          error: {
            api: anthropicModel.api,
            content: [],
            errorMessage: "Unhandled stop reason: sensitive",
            model: anthropicModel.id,
            provider: anthropicModel.provider,
            role: "assistant",
            stopReason: "error",
            timestamp: Date.now(),
            usage: {
              cacheRead: 0,
              cacheWrite: 0,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
              input: 0,
              output: 0,
              totalTokens: 0,
            },
          },
          reason: "error",
          type: "error",
        });
        stream.end();
      });
      return stream;
    };

    const wrapped = wrapStreamFnHandleSensitiveStopReason(baseStreamFn);
    const stream = await Promise.resolve(
      wrapped(anthropicModel, { messages: [] } as Context, undefined),
    );
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "The model stopped because the provider returned an unhandled stop reason: sensitive. Please rephrase and try again.",
    );
  });

  it("includes the extracted stop reason when converting synchronous throws", async () => {
    const baseStreamFn: StreamFn = () => {
      throw new Error("Unhandled stop reason: refusal_policy");
    };

    const wrapped = wrapStreamFnHandleSensitiveStopReason(baseStreamFn);
    const stream = await Promise.resolve(
      wrapped(anthropicModel, { messages: [] } as Context, undefined),
    );
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "The model stopped because the provider returned an unhandled stop reason: refusal_policy. Please rephrase and try again.",
    );
  });
});
