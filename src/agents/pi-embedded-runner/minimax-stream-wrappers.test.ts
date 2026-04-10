import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createMinimaxFastModeWrapper,
  createMinimaxThinkingDisabledWrapper,
} from "./minimax-stream-wrappers.js";

function captureThinkingPayload(params: {
  provider: string;
  api: string;
  modelId: string;
}): unknown {
  let capturedThinking: unknown = undefined;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload: Record<string, unknown> = {};
    options?.onPayload?.(payload, _model);
    capturedThinking = payload.thinking;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
  void wrapped(
    {
      api: params.api,
      id: params.modelId,
      provider: params.provider,
    } as Model<"anthropic-messages">,
    { messages: [] } as Context,
    {},
  );

  return capturedThinking;
}

describe("createMinimaxThinkingDisabledWrapper", () => {
  it("disables thinking for minimax anthropic-messages provider", () => {
    expect(
      captureThinkingPayload({
        api: "anthropic-messages",
        modelId: "MiniMax-M2.7",
        provider: "minimax",
      }),
    ).toEqual({ type: "disabled" });
  });

  it("disables thinking for minimax-portal anthropic-messages provider", () => {
    expect(
      captureThinkingPayload({
        api: "anthropic-messages",
        modelId: "MiniMax-M2.7",
        provider: "minimax-portal",
      }),
    ).toEqual({ type: "disabled" });
  });

  it("does not affect non-minimax providers", () => {
    expect(
      captureThinkingPayload({
        api: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
        provider: "anthropic",
      }),
    ).toBeUndefined();
  });

  it("does not affect minimax with non-anthropic-messages api", () => {
    expect(
      captureThinkingPayload({
        api: "openai-completions",
        modelId: "MiniMax-M2.7",
        provider: "minimax",
      }),
    ).toBeUndefined();
  });

  it("preserves an already-set thinking value", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { budget_tokens: 1024, type: "enabled" },
      };
      options?.onPayload?.(payload, _model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "anthropic-messages",
        id: "MiniMax-M2.7",
        provider: "minimax",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toEqual({ budget_tokens: 1024, type: "enabled" });
  });
});

describe("createMinimaxFastModeWrapper", () => {
  it("rewrites MiniMax-M2.7 to highspeed variant in fast mode", () => {
    let capturedId = "";
    const baseStreamFn: StreamFn = (model) => {
      capturedId = model.id;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxFastModeWrapper(baseStreamFn, true);
    void wrapped(
      {
        api: "anthropic-messages",
        id: "MiniMax-M2.7",
        provider: "minimax",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedId).toBe("MiniMax-M2.7-highspeed");
  });
});
