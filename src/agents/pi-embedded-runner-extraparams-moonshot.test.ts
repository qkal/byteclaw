import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfiguredOllamaCompatStreamWrapper } from "../plugin-sdk/ollama-runtime.js";
import { __testing as extraParamsTesting } from "./pi-embedded-runner/extra-params.js";
import { applyExtraParamsToAgent } from "./pi-embedded-runner/extra-params.js";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "./pi-embedded-runner/moonshot-stream-wrappers.js";

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    wrapProviderStreamFn: (params) => {
      if (params.provider === "moonshot") {
        const thinkingType = resolveMoonshotThinkingType({
          configuredThinking: params.context.extraParams?.thinking,
          thinkingLevel: params.context.thinkingLevel,
        });
        return createMoonshotThinkingWrapper(params.context.streamFn, thinkingType);
      }
      if (params.provider === "ollama") {
        return createConfiguredOllamaCompatStreamWrapper(params.context);
      }
      return params.context.streamFn;
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("applyExtraParamsToAgent Moonshot and Ollama Kimi", () => {
  function runPayloadCase(params: {
    provider: "moonshot" | "ollama";
    modelId: string;
    thinkingLevel?: "off" | "low" | "medium" | "high";
    payload?: Record<string, unknown>;
    cfg?: Record<string, unknown>;
  }) {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = { ...params.payload };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.provider,
      params.modelId,
      undefined,
      params.thinkingLevel,
    );

    const model = {
      api: "openai-completions",
      id: params.modelId,
      provider: params.provider,
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    return payloads[0] ?? {};
  }

  it("maps thinkingLevel=off to Moonshot thinking.type=disabled", () => {
    const payload = runPayloadCase({
      modelId: "kimi-k2.5",
      provider: "moonshot",
      thinkingLevel: "off",
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("maps non-off thinking levels to Moonshot thinking.type=enabled and normalizes tool_choice", () => {
    const payload = runPayloadCase({
      modelId: "kimi-k2.5",
      payload: { tool_choice: "required" },
      provider: "moonshot",
      thinkingLevel: "low",
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.tool_choice).toBe("auto");
  });

  it("disables thinking instead of broadening pinned Moonshot tool_choice", () => {
    const payload = runPayloadCase({
      modelId: "kimi-k2.5",
      payload: { tool_choice: { name: "read", type: "tool" } },
      provider: "moonshot",
      thinkingLevel: "low",
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.tool_choice).toEqual({ name: "read", type: "tool" });
  });

  it("respects explicit Moonshot thinking param from model config", () => {
    const payload = runPayloadCase({
      cfg: {
        agents: {
          defaults: {
            models: {
              "moonshot/kimi-k2.5": {
                params: {
                  thinking: { type: "disabled" },
                },
              },
            },
          },
        },
      },
      modelId: "kimi-k2.5",
      provider: "moonshot",
      thinkingLevel: "high",
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("applies Moonshot payload compatibility to Ollama Kimi cloud models", () => {
    const payload = runPayloadCase({
      modelId: "kimi-k2.5:cloud",
      payload: { tool_choice: "required" },
      provider: "ollama",
      thinkingLevel: "low",
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.tool_choice).toBe("auto");
  });

  it("maps thinkingLevel=off for Ollama Kimi cloud models through Moonshot compatibility", () => {
    const payload = runPayloadCase({
      modelId: "kimi-k2.5:cloud",
      provider: "ollama",
      thinkingLevel: "off",
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("disables thinking instead of broadening pinned Ollama Kimi cloud tool_choice", () => {
    const payload = runPayloadCase({
      modelId: "kimi-k2.5:cloud",
      payload: { tool_choice: { function: { name: "read" }, type: "function" } },
      provider: "ollama",
      thinkingLevel: "low",
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.tool_choice).toEqual({
      function: { name: "read" },
      type: "function",
    });
  });
});
