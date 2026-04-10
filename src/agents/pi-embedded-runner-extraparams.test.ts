import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicServiceTierWrapper,
  resolveAnthropicBetas,
  resolveAnthropicFastMode,
  resolveAnthropicServiceTier,
} from "../../test/helpers/providers/anthropic-contract.js";
import { __testing as extraParamsTesting } from "./pi-embedded-runner/extra-params.js";

const XAI_FAST_MODEL_IDS = new Map<string, string>([
  ["grok-3", "grok-3-fast"],
  ["grok-3-mini", "grok-3-mini-fast"],
  ["grok-4", "grok-4-fast"],
  ["grok-4-0709", "grok-4-fast"],
]);

function createTestXaiFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  return (model, context, options) => {
    if (!fastMode || model.api !== "openai-completions" || model.provider !== "xai") {
      return (
        baseStreamFn ??
        (() => {
          throw new Error("missing stream function");
        })
      )(model, context, options);
    }

    const fastModelId = XAI_FAST_MODEL_IDS.get(String(model.id).trim());
    return (
      baseStreamFn ??
      (() => {
        throw new Error("missing stream function");
      })
    )(fastModelId ? { ...model, id: fastModelId } : model, context, options);
  };
}

function stripTestXaiUnsupportedStrictFlag(tool: unknown): unknown {
  if (!tool || typeof tool !== "object") {
    return tool;
  }
  const toolObj = tool as Record<string, unknown>;
  const fn = toolObj.function;
  if (!fn || typeof fn !== "object") {
    return tool;
  }
  const fnObj = fn as Record<string, unknown>;
  if (typeof fnObj.strict !== "boolean") {
    return tool;
  }
  const nextFunction = { ...fnObj };
  delete nextFunction.strict;
  return { ...toolObj, function: nextFunction };
}

function createTestXaiPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return (model, context, options) => {
    const underlying =
      baseStreamFn ??
      (() => {
        throw new Error("missing stream function");
      });
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (Array.isArray(payloadObj.tools)) {
            payloadObj.tools = payloadObj.tools.map((tool) =>
              stripTestXaiUnsupportedStrictFlag(tool),
            );
          }
          delete payloadObj.reasoning;
          delete payloadObj.reasoningEffort;
          delete payloadObj.reasoning_effort;
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

function createTestToolStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  return (model, context, options) => {
    const underlying =
      baseStreamFn ??
      (() => {
        throw new Error("missing stream function");
      });
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (enabled && payload && typeof payload === "object") {
          (payload as Record<string, unknown>).tool_stream = true;
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

import { createAnthropicToolPayloadCompatibilityWrapper } from "./pi-embedded-runner/anthropic-family-tool-payload-compat.js";
import {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
} from "./pi-embedded-runner/bedrock-stream-wrappers.js";
import {
  applyExtraParamsToAgent,
  resolveAgentTransportOverride,
  resolvePreparedExtraParams,
} from "./pi-embedded-runner/extra-params.js";
import { createGoogleThinkingPayloadWrapper } from "./pi-embedded-runner/google-stream-wrappers.js";
import { log } from "./pi-embedded-runner/logger.js";
import { createMinimaxFastModeWrapper } from "./pi-embedded-runner/minimax-stream-wrappers.js";
import {
  createCodexNativeWebSearchWrapper,
  createOpenAIAttributionHeadersWrapper,
  createOpenAIDefaultTransportWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  createOpenAIStringContentWrapper,
  createOpenAITextVerbosityWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
  resolveOpenAITextVerbosity,
} from "./pi-embedded-runner/openai-stream-wrappers.js";

type WrapProviderStreamFnParams = Parameters<
  typeof import("../plugins/provider-runtime.js").wrapProviderStreamFn
>[0];

function createTestOpenAIProviderWrapper(
  params: WrapProviderStreamFnParams,
  withDefaultTransport: boolean,
): StreamFn {
  let {streamFn} = params.context;
  if (withDefaultTransport) {
    streamFn = createOpenAIDefaultTransportWrapper(streamFn);
  }
  streamFn = createOpenAIAttributionHeadersWrapper(streamFn);

  if (resolveOpenAIFastMode(params.context.extraParams)) {
    streamFn = createOpenAIFastModeWrapper(streamFn);
  }

  const serviceTier = resolveOpenAIServiceTier(params.context.extraParams);
  if (serviceTier) {
    streamFn = createOpenAIServiceTierWrapper(streamFn, serviceTier);
  }

  const textVerbosity = resolveOpenAITextVerbosity(params.context.extraParams);
  if (textVerbosity) {
    streamFn = createOpenAITextVerbosityWrapper(streamFn, textVerbosity);
  }

  streamFn = createCodexNativeWebSearchWrapper(streamFn, {
    agentDir: params.context.agentDir,
    config: params.context.config,
  });
  streamFn = createOpenAIStringContentWrapper(streamFn);
  return createOpenAIResponsesContextManagementWrapper(
    createOpenAIReasoningCompatibilityWrapper(streamFn),
    params.context.extraParams,
  );
}

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: (params) => {
      if (params.provider !== "openai-codex") {
        return undefined;
      }
      const transport = params.context.extraParams?.transport;
      if (transport === "auto" || transport === "sse" || transport === "websocket") {
        return params.context.extraParams;
      }
      return {
        ...params.context.extraParams,
        transport: "auto",
      };
    },
    wrapProviderStreamFn: (params) => {
      if (params.provider === "openai") {
        return createTestOpenAIProviderWrapper(params, true);
      }
      if (params.provider === "openai-codex") {
        return createTestOpenAIProviderWrapper(params, false);
      }
      if (params.provider === "azure-openai" || params.provider === "azure-openai-responses") {
        return createTestOpenAIProviderWrapper(params, false);
      }
      if (params.provider === "amazon-bedrock") {
        return isAnthropicBedrockModel(params.context.modelId)
          ? params.context.streamFn
          : createBedrockNoCacheWrapper(params.context.streamFn);
      }
      if (params.provider === "google") {
        return createGoogleThinkingPayloadWrapper(
          params.context.streamFn,
          params.context.thinkingLevel,
        );
      }
      if (params.provider === "test-anthropic-tool-compat") {
        return createAnthropicToolPayloadCompatibilityWrapper(params.context.streamFn, {
          toolChoiceMode: "openai-string-modes",
          toolSchemaMode: "openai-functions",
        });
      }
      if (params.provider === "kimi") {
        return params.context.streamFn;
      }
      if (params.provider === "minimax" || params.provider === "minimax-portal") {
        return createMinimaxFastModeWrapper(
          params.context.streamFn,
          params.context.extraParams?.fastMode === true,
        );
      }
      if (params.provider === "xai") {
        let streamFn = createTestXaiPayloadCompatibilityWrapper(params.context.streamFn);
        streamFn = createTestXaiFastModeWrapper(
          streamFn,
          params.context.extraParams?.fastMode === true,
        );
        return createTestToolStreamWrapper(
          streamFn,
          params.context.extraParams?.tool_stream !== false,
        );
      }
      if (params.provider === "anthropic") {
        let {streamFn} = params.context;
        const anthropicBetas = resolveAnthropicBetas(
          params.context.extraParams,
          params.context.modelId,
        );
        if (anthropicBetas?.length) {
          streamFn = createAnthropicBetaHeadersWrapper(streamFn, anthropicBetas);
        }
        const serviceTier = resolveAnthropicServiceTier(params.context.extraParams);
        if (serviceTier) {
          streamFn = createAnthropicServiceTierWrapper(streamFn, serviceTier);
        }
        const fastMode = resolveAnthropicFastMode(params.context.extraParams);
        if (fastMode !== undefined) {
          streamFn = createAnthropicFastModeWrapper(streamFn, fastMode);
        }
        return streamFn;
      }
      return params.context.streamFn;
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("applyExtraParamsToAgent", () => {
  function createOptionsCaptureAgent() {
    const calls: ((SimpleStreamOptions & { openaiWsWarmup?: boolean }) | undefined)[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options as (SimpleStreamOptions & { openaiWsWarmup?: boolean }) | undefined);
      return {} as ReturnType<StreamFn>;
    };
    return {
      agent: { streamFn: baseStreamFn },
      calls,
    };
  }

  function buildAnthropicModelConfig(modelKey: string, params: Record<string, unknown>) {
    return {
      agents: {
        defaults: {
          models: {
            [modelKey]: { params },
          },
        },
      },
    };
  }

  function runResponsesPayloadMutationCase(params: {
    applyProvider: string;
    applyModelId: string;
    model:
      | Model<"openai-responses">
      | Model<"azure-openai-responses">
      | Model<"openai-codex-responses">
      | Model<"openai-completions">
      | Model<"anthropic-messages">;
    options?: SimpleStreamOptions;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) {
    const payload = params.payload ?? { store: false };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.applyProvider,
      params.applyModelId,
      params.extraParamsOverride,
    );
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, params.options ?? {});
    return payload;
  }

  function runResolvedModelIdCase(params: {
    applyProvider: string;
    applyModelId: string;
    model: Model<"anthropic-messages"> | Model<"openai-completions">;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
  }): string {
    let resolvedModelId = params.model.id;
    const baseStreamFn: StreamFn = (model) => {
      resolvedModelId = String(model.id ?? "");
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.applyProvider,
      params.applyModelId,
      params.extraParamsOverride,
    );
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, {});
    return resolvedModelId;
  }

  function runParallelToolCallsPayloadMutationCase(params: {
    applyProvider: string;
    applyModelId: string;
    model:
      | Model<"openai-completions">
      | Model<"openai-responses">
      | Model<"azure-openai-responses">
      | Model<"anthropic-messages">;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) {
    const payload = params.payload ?? {};
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.applyProvider,
      params.applyModelId,
      params.extraParamsOverride,
    );
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, {});
    return payload;
  }

  function runToolPayloadMutationCase(params: {
    applyProvider: "openai" | "xai";
    applyModelId: string;
    model: Model<"openai-completions">;
  }) {
    const payload: {
      tools: { function?: Record<string, unknown> }[];
    } = {
      tools: [
        {
          function: {
            description: "write a file",
            name: "write",
            parameters: { properties: {}, type: "object" },
            strict: true,
          },
        },
      ],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload as unknown as Record<string, unknown>, model);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(agent, undefined, params.applyProvider, params.applyModelId);
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, {});
    return payload;
  }

  function runAnthropicHeaderCase(params: {
    cfg: Record<string, unknown>;
    modelId: string;
    options?: SimpleStreamOptions;
  }) {
    const { calls, agent } = createOptionsCaptureAgent();
    applyExtraParamsToAgent(agent, params.cfg, "anthropic", params.modelId);

    const model = {
      api: "anthropic-messages",
      id: params.modelId,
      provider: "anthropic",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, params.options ?? {});

    expect(calls).toHaveLength(1);
    return calls[0]?.headers;
  }

  it("disables thinking for MiniMax anthropic-messages payloads", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "minimax", "MiniMax-M2.7");

    const model = {
      api: "anthropic-messages",
      id: "MiniMax-M2.7",
      provider: "minimax",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toEqual({ type: "disabled" });
  });

  it("strips xai Responses reasoning payload fields", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "grok-4.20-beta-latest-reasoning",
      applyProvider: "xai",
      model: {
        api: "openai-responses",
        id: "grok-4.20-beta-latest-reasoning",
        provider: "xai",
      } as Model<"openai-responses">,
      payload: {
        input: [],
        model: "grok-4.20-beta-latest-reasoning",
        reasoning: { effort: "high", summary: "auto" },
        reasoningEffort: "high",
        reasoning_effort: "high",
      },
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("keeps disabled reasoning payloads for native OpenAI responses routes", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        reasoning: { effort: "none", summary: "auto" },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5", undefined, "off");

    const model = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      id: "gpt-5",
      provider: "openai",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      context_management: [{ compact_threshold: 80_000, type: "compaction" }],
      parallel_tool_calls: true,
      reasoning: { effort: "none", summary: "auto" },
      store: true,
      text: { verbosity: "low" },
    });
  });

  it("keeps disabled reasoning payloads for proxied OpenAI responses routes", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        reasoning: { effort: "none", summary: "auto" },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5", undefined, "off");

    const model = {
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      id: "gpt-5",
      provider: "openai",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty("reasoning");
  });

  it("injects parallel_tool_calls for openai-completions payloads when configured", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyModelId: "moonshotai/kimi-k2.5",
      applyProvider: "nvidia-nim",
      cfg: {
        agents: {
          defaults: {
            models: {
              "nvidia-nim/moonshotai/kimi-k2.5": {
                params: {
                  parallel_tool_calls: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-completions",
        id: "moonshotai/kimi-k2.5",
        provider: "nvidia-nim",
      } as Model<"openai-completions">,
    });

    expect(payload.parallel_tool_calls).toBe(false);
  });

  it("flattens pure text OpenAI completions message arrays for string-only compat models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "google/gemma-4-E2B-it",
      applyProvider: "inferrs",
      model: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        compat: {
          requiresStringContent: true,
        } as Record<string, unknown>,
        contextWindow: 131072,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "google/gemma-4-E2B-it",
        input: ["text"],
        maxTokens: 4096,
        name: "Gemma 4 E2B (inferrs)",
        provider: "inferrs",
        reasoning: false,
      } as unknown as Model<"openai-completions">,
      payload: {
        messages: [
          {
            content: [{ type: "text", text: "System text" }],
            role: "system",
          },
          {
            content: [
              { type: "text", text: "Line one" },
              { type: "text", text: "Line two" },
            ],
            role: "user",
          },
        ],
      },
    });

    expect(payload.messages).toEqual([
      {
        content: "System text",
        role: "system",
      },
      {
        content: "Line one\nLine two",
        role: "user",
      },
    ]);
  });

  it("injects parallel_tool_calls for openai-responses payloads when configured", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5": {
                params: {
                  parallelToolCalls: true,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });

    expect(payload.parallel_tool_calls).toBe(true);
  });

  it("strips function.strict for xai providers", () => {
    const payload = runToolPayloadMutationCase({
      applyModelId: "grok-4-1-fast-reasoning",
      applyProvider: "xai",
      model: {
        api: "openai-completions",
        id: "grok-4-1-fast-reasoning",
        provider: "xai",
      } as Model<"openai-completions">,
    });

    expect(payload.tools[0]?.function).not.toHaveProperty("strict");
  });

  it("keeps function.strict for non-xai providers", () => {
    const payload = runToolPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      model: {
        api: "openai-completions",
        id: "gpt-5.4",
        provider: "openai",
      } as Model<"openai-completions">,
    });

    expect(payload.tools[0]?.function?.strict).toBe(true);
  });

  it("injects parallel_tool_calls for azure-openai-responses payloads when configured", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "azure-openai-responses",
      cfg: {
        agents: {
          defaults: {
            models: {
              "azure-openai-responses/gpt-5": {
                params: {
                  parallelToolCalls: true,
                },
              },
            },
          },
        },
      },
      model: {
        api: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        id: "gpt-5",
        provider: "azure-openai-responses",
      } as unknown as Model<"azure-openai-responses">,
    });

    expect(payload.parallel_tool_calls).toBe(true);
  });

  it("does not inject parallel_tool_calls for unsupported APIs", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyModelId: "claude-sonnet-4-6",
      applyProvider: "anthropic",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {
                params: {
                  parallel_tool_calls: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        id: "claude-sonnet-4-6",
        provider: "anthropic",
      } as Model<"anthropic-messages">,
    });

    expect(payload).not.toHaveProperty("parallel_tool_calls");
  });

  it("lets runtime override win across alias styles for parallel_tool_calls", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyModelId: "moonshotai/kimi-k2.5",
      applyProvider: "nvidia-nim",
      cfg: {
        agents: {
          defaults: {
            models: {
              "nvidia-nim/moonshotai/kimi-k2.5": {
                params: {
                  parallel_tool_calls: true,
                },
              },
            },
          },
        },
      },
      extraParamsOverride: {
        parallelToolCalls: false,
      },
      model: {
        api: "openai-completions",
        id: "moonshotai/kimi-k2.5",
        provider: "nvidia-nim",
      } as Model<"openai-completions">,
    });

    expect(payload.parallel_tool_calls).toBe(false);
  });

  it("lets null runtime override suppress inherited parallel_tool_calls injection", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyModelId: "moonshotai/kimi-k2.5",
      applyProvider: "nvidia-nim",
      cfg: {
        agents: {
          defaults: {
            models: {
              "nvidia-nim/moonshotai/kimi-k2.5": {
                params: {
                  parallel_tool_calls: true,
                },
              },
            },
          },
        },
      },
      extraParamsOverride: {
        parallelToolCalls: null,
      },
      model: {
        api: "openai-completions",
        id: "moonshotai/kimi-k2.5",
        provider: "nvidia-nim",
      } as Model<"openai-completions">,
    });

    expect(payload).not.toHaveProperty("parallel_tool_calls");
  });

  it("warns and skips invalid parallel_tool_calls values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runParallelToolCallsPayloadMutationCase({
        applyModelId: "moonshotai/kimi-k2.5",
        applyProvider: "nvidia-nim",
        cfg: {
          agents: {
            defaults: {
              models: {
                "nvidia-nim/moonshotai/kimi-k2.5": {
                  params: {
                    parallelToolCalls: "false",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "openai-completions",
          id: "moonshotai/kimi-k2.5",
          provider: "nvidia-nim",
        } as Model<"openai-completions">,
      });

      expect(payload).not.toHaveProperty("parallel_tool_calls");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid parallel_tool_calls param: false");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("normalizes thinking=off to null for SiliconFlow Pro models", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { thinking: "off" };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "siliconflow",
      "Pro/MiniMaxAI/MiniMax-M2.7",
      undefined,
      "off",
    );

    const model = {
      api: "openai-completions",
      id: "Pro/MiniMaxAI/MiniMax-M2.7",
      provider: "siliconflow",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toBeNull();
  });

  it("keeps thinking=off unchanged for non-Pro SiliconFlow model IDs", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { thinking: "off" };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "siliconflow",
      "deepseek-ai/DeepSeek-V3.2",
      undefined,
      "off",
    );

    const model = {
      api: "openai-completions",
      id: "deepseek-ai/DeepSeek-V3.2",
      provider: "siliconflow",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toBe("off");
  });

  it("keeps anthropic tool payloads native for Kimi", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tool_choice: { name: "read", type: "tool" },
        tools: [
          {
            description: "Read file",
            input_schema: {
              properties: { path: { type: "string" } },
              required: ["path"],
              type: "object",
            },
            name: "read",
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "kimi", "kimi-code", undefined, "low");

    const model = {
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding/",
      id: "kimi-code",
      provider: "kimi",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.tools).toEqual([
      {
        description: "Read file",
        input_schema: {
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object",
        },
        name: "read",
      },
    ]);
    expect(payloads[0]?.tool_choice).toEqual({ name: "read", type: "tool" });
  });

  it("does not rewrite anthropic tool schema for non-kimi endpoints", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tools: [
          {
            description: "Read file",
            input_schema: { properties: {}, type: "object" },
            name: "read",
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "anthropic", "claude-sonnet-4-6", undefined, "low");

    const model = {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      id: "claude-sonnet-4-6",
      provider: "anthropic",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.tools).toEqual([
      {
        description: "Read file",
        input_schema: { properties: {}, type: "object" },
        name: "read",
      },
    ]);
  });

  it("uses explicit compat metadata for anthropic tool payload normalization", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tools: [
          {
            description: "Read file",
            input_schema: { properties: {}, type: "object" },
            name: "read",
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const streamFn = createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn);

    const model = {
      api: "anthropic-messages",
      compat: {
        requiresOpenAiAnthropicToolPayload: true,
      },
      id: "proxy-model",
      provider: "custom-anthropic-proxy",
    } as unknown as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void streamFn(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.tools).toEqual([
      {
        function: {
          description: "Read file",
          name: "read",
          parameters: { properties: {}, type: "object" },
        },
        type: "function",
      },
    ]);
  });

  it("lets provider-owned wrappers normalize anthropic tool payloads", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tool_choice: { type: "any" },
        tools: [
          {
            description: "Read file",
            input_schema: { properties: {}, type: "object" },
            name: "read",
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "test-anthropic-tool-compat",
      "proxy-model",
      undefined,
      "low",
    );

    const model = {
      api: "anthropic-messages",
      id: "proxy-model",
      provider: "test-anthropic-tool-compat",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.tools).toEqual([
      {
        function: {
          description: "Read file",
          name: "read",
          parameters: { properties: {}, type: "object" },
        },
        type: "function",
      },
    ]);
    expect(payloads[0]?.tool_choice).toBe("required");
  });

  it("sanitizes invalid Atproxy Gemini negative thinking budgets", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        config: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: -1,
          },
        },
        contents: [
          {
            parts: [
              { text: "describe image" },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: "ZmFrZQ==",
                },
              },
            ],
            role: "user",
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "atproxy", "gemini-3.1-pro-high", undefined, "high");

    const model = {
      api: "google-generative-ai",
      id: "gemini-3.1-pro-high",
      provider: "atproxy",
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    const thinkingConfig = (
      payloads[0]?.config as { thinkingConfig?: Record<string, unknown> } | undefined
    )?.thinkingConfig;
    expect(thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(
      (
        payloads[0]?.contents as
          | { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }[]
          | undefined
      )?.[0]?.parts?.[1]?.inlineData,
    ).toEqual({
      data: "ZmFrZQ==",
      mimeType: "image/png",
    });
  });

  it("keeps valid Google thinkingBudget unchanged", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        config: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 2048,
          },
        },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "atproxy", "gemini-3.1-pro-high", undefined, "high");

    const model = {
      api: "google-generative-ai",
      id: "gemini-3.1-pro-high",
      provider: "atproxy",
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toEqual({
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 2048,
      },
    });
  });

  it("rewrites Gemma 4 thinkingBudget to a supported Google thinkingLevel", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        config: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 24_576,
          },
        },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "google", "gemma-4-26b-a4b-it", undefined, "high");

    const model = {
      api: "google-generative-ai",
      id: "gemma-4-26b-a4b-it",
      provider: "google",
      reasoning: true,
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toEqual({
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: "HIGH",
      },
    });
  });

  it("preserves Gemma 4 thinking off instead of rewriting thinkingBudget=0 to MINIMAL", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        config: {
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "google", "gemma-4-26b-a4b-it", undefined, "off");

    const model = {
      api: "google-generative-ai",
      id: "gemma-4-26b-a4b-it",
      provider: "google",
      reasoning: true,
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toEqual({});
  });

  it("preserves explicit Gemma 4 thinking level when thinkingBudget=0", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        config: {
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "google", "gemma-4-26b-a4b-it", undefined, "high");

    const model = {
      api: "google-generative-ai",
      id: "gemma-4-26b-a4b-it",
      provider: "google",
      reasoning: true,
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toEqual({
      thinkingConfig: {
        thinkingLevel: "HIGH",
      },
    });
  });
  it("passes configured websocket transport through stream options", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "websocket",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      id: "gpt-5.4",
      provider: "openai-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("websocket");
  });

  it("passes configured websocket transport through stream options for openai-codex gpt-5.4", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "websocket",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      id: "gpt-5.4",
      provider: "openai-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("websocket");
  });

  it("defaults Codex transport to auto (WebSocket-first)", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      id: "gpt-5.4",
      provider: "openai-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("auto");
  });

  it("defaults OpenAI transport to auto with websocket warm-up", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      id: "gpt-5",
      provider: "openai",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("auto");
    expect(calls[0]?.openaiWsWarmup).toBe(true);
  });

  it("injects GPT-5 default parallel tool calls and low verbosity for OpenAI Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      model: {
        api: "openai-responses",
        id: "gpt-5.4",
        provider: "openai",
      } as Model<"openai-responses">,
      payload: {},
    });

    expect(payload.parallel_tool_calls).toBe(true);
    expect(payload.text).toEqual({ verbosity: "low" });
  });

  it("injects native Codex web_search for direct openai-codex Responses models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai-codex",
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
      model: {
        api: "openai-codex-responses",
        id: "gpt-5.4",
        provider: "openai-codex",
      } as Model<"openai-codex-responses">,
      payload: { tools: [{ name: "read", type: "function" }] },
    });

    expect(payload.tools).toEqual([
      { name: "read", type: "function" },
      {
        external_web_access: true,
        filters: { allowed_domains: ["example.com"] },
        type: "web_search",
      },
    ]);
  });

  it("does not inject duplicate native Codex web_search tools", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "gateway",
      cfg: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: {
                enabled: true,
                mode: "cached",
              },
            },
          },
        },
      },
      model: {
        api: "openai-codex-responses",
        id: "gpt-5.4",
        provider: "gateway",
      } as Model<"openai-codex-responses">,
      payload: { tools: [{ type: "web_search" }] },
    });

    expect(payload.tools).toEqual([{ type: "web_search" }]);
  });

  it("keeps payload unchanged when Codex native search is inactive", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "openai",
      cfg: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: {
                enabled: true,
                mode: "cached",
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        id: "gpt-5",
        provider: "openai",
      } as Model<"openai-responses">,
      payload: { tools: [{ name: "read", type: "function" }] },
    });

    expect(payload.tools).toEqual([{ name: "read", type: "function" }]);
  });

  it("lets runtime options override OpenAI default transport", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      id: "gpt-5",
      provider: "openai",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, { transport: "sse" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("sse");
  });

  it("allows disabling OpenAI websocket warm-up via model params", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5": {
              params: {
                openaiWsWarmup: false,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      id: "gpt-5",
      provider: "openai",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.openaiWsWarmup).toBe(false);
  });

  it("lets runtime options override configured OpenAI websocket warm-up", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5": {
              params: {
                openaiWsWarmup: false,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      id: "gpt-5",
      provider: "openai",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {
      openaiWsWarmup: true,
    } as unknown as SimpleStreamOptions);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.openaiWsWarmup).toBe(true);
  });

  it("allows forcing Codex transport to SSE", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "sse",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      id: "gpt-5.4",
      provider: "openai-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("sse");
  });

  it("lets runtime options override configured transport", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "websocket",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      id: "gpt-5.4",
      provider: "openai-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, { transport: "sse" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("sse");
  });

  it("falls back to Codex default transport when configured value is invalid", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "udp",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      id: "gpt-5.4",
      provider: "openai-codex",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("auto");
  });

  it("returns prepared Codex transport defaults for runtime sessions", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      modelId: "gpt-5.4",
      provider: "openai-codex",
    });

    expect(effectiveExtraParams.transport).toBe("auto");
  });

  it("uses prepared transport when session settings did not explicitly set one", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      modelId: "gpt-5.4",
      provider: "openai-codex",
    });

    expect(
      resolveAgentTransportOverride({
        effectiveExtraParams,
        settingsManager: {
          getGlobalSettings: () => ({}),
          getProjectSettings: () => ({}),
        },
      }),
    ).toBe("auto");
  });

  it("keeps explicit session transport over prepared OpenAI defaults", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      modelId: "gpt-5",
      provider: "openai",
    });

    expect(
      resolveAgentTransportOverride({
        effectiveExtraParams,
        settingsManager: {
          getGlobalSettings: () => ({ transport: "sse" }),
          getProjectSettings: () => ({}),
        },
      }),
    ).toBeUndefined();
  });

  it("strips prototype pollution keys from extra params overrides", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      extraParamsOverride: {
        __proto__: { polluted: true },
        constructor: "blocked",
        prototype: "blocked",
        temperature: 0.2,
      },
      modelId: "gpt-5",
      provider: "openai",
    });

    expect(effectiveExtraParams.temperature).toBe(0.2);
    expect(Object.hasOwn(effectiveExtraParams, "__proto__")).toBe(false);
    expect(Object.hasOwn(effectiveExtraParams, "constructor")).toBe(false);
    expect(Object.hasOwn(effectiveExtraParams, "prototype")).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("keeps Anthropic Bedrock models eligible for provider-side caching", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "amazon-bedrock", "us.anthropic.claude-sonnet-4-5");

    const model = {
      api: "openai-completions",
      id: "us.anthropic.claude-sonnet-4-5",
      provider: "amazon-bedrock",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBeUndefined();
  });

  it("passes through explicit cacheRetention for Anthropic Bedrock models", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "amazon-bedrock/us.anthropic.claude-opus-4-6-v1": {
              params: {
                cacheRetention: "long",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "amazon-bedrock", "us.anthropic.claude-opus-4-6-v1");

    const model = {
      api: "openai-completions",
      id: "us.anthropic.claude-opus-4-6-v1",
      provider: "amazon-bedrock",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe("long");
  });

  it("passes through explicit cacheRetention for custom anthropic-messages providers", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "litellm/claude-sonnet-4-6": {
              params: {
                cacheRetention: "long",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(
      agent,
      cfg,
      "litellm",
      "claude-sonnet-4-6",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        api: "anthropic-messages",
        id: "claude-sonnet-4-6",
        provider: "litellm",
      } as Model<"anthropic-messages">,
    );

    const context: Context = { messages: [] };

    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        id: "claude-sonnet-4-6",
        provider: "litellm",
      } as Model<"anthropic-messages">,
      context,
      {},
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe("long");
  });

  it("adds Anthropic 1M beta header when context1m is enabled for Opus/Sonnet", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildAnthropicModelConfig("anthropic/claude-opus-4-6", { context1m: true });

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-6");

    const model = {
      api: "anthropic-messages",
      id: "claude-opus-4-6",
      provider: "anthropic",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    // Simulate pi-agent-core passing apiKey in options (API key, not OAuth token)
    void agent.streamFn?.(model, context, {
      apiKey: "sk-ant-api03-test", // Pragma: allowlist secret
      headers: { "X-Custom": "1" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      "X-Custom": "1",
      // Includes pi-ai default betas (preserved to avoid overwrite) + context1m
      "anthropic-beta":
        "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14,context-1m-2025-08-07",
    });
  });

  it("does not add Anthropic 1M beta header when context1m is not enabled", () => {
    const cfg = buildAnthropicModelConfig("anthropic/claude-opus-4-6", {
      temperature: 0.2,
    });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-opus-4-6",
      options: { headers: { "X-Custom": "1" } },
    });

    expect(headers).toEqual({ "X-Custom": "1" });
  });

  it("skips context1m beta for OAuth tokens but preserves OAuth-required betas", () => {
    const calls: (SimpleStreamOptions | undefined)[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {
              params: {
                context1m: true,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-sonnet-4-6");

    const model = {
      api: "anthropic-messages",
      id: "claude-sonnet-4-6",
      provider: "anthropic",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    // Simulate pi-agent-core passing an OAuth token (sk-ant-oat-*) as apiKey
    void agent.streamFn?.(model, context, {
      apiKey: "sk-ant-oat01-test-oauth-token", // Pragma: allowlist secret
      headers: { "X-Custom": "1" },
    });

    expect(calls).toHaveLength(1);
    const betaHeader = calls[0]?.headers?.["anthropic-beta"] as string;
    // Must include the OAuth-required betas so they aren't stripped by pi-ai's mergeHeaders
    expect(betaHeader).toContain("oauth-2025-04-20");
    expect(betaHeader).toContain("claude-code-20250219");
    expect(betaHeader).not.toContain("context-1m-2025-08-07");
  });

  it("merges existing anthropic-beta headers with configured betas", () => {
    const cfg = buildAnthropicModelConfig("anthropic/claude-sonnet-4-5", {
      anthropicBeta: ["files-api-2025-04-14"],
      context1m: true,
    });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-sonnet-4-5",
      options: {
        apiKey: "sk-ant-api03-test", // Pragma: allowlist secret
        headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
      },
    });

    expect(headers).toEqual({
      "anthropic-beta":
        "prompt-caching-2024-07-31,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14,files-api-2025-04-14,context-1m-2025-08-07",
    });
  });

  it("ignores context1m for non-Opus/Sonnet Anthropic models", () => {
    const cfg = buildAnthropicModelConfig("anthropic/claude-haiku-3-5", { context1m: true });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-haiku-3-5",
      options: { headers: { "X-Custom": "1" } },
    });
    expect(headers).toEqual({ "X-Custom": "1" });
  });

  it("forces store=true for direct OpenAI Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "openai",
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(true);
  });

  it("forces store=true for azure-openai provider with openai-responses API (#42800)", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5-mini",
      applyProvider: "azure-openai",
      model: {
        api: "openai-responses",
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
        id: "gpt-5-mini",
        provider: "azure-openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(true);
  });

  it("keeps disabled OpenAI reasoning payloads on native Responses routes", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5-mini",
      applyProvider: "openai",
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5-mini",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "none" },
        store: false,
      },
    });
    expect(payload.reasoning).toEqual({ effort: "none" });
  });

  it("keeps disabled Azure OpenAI Responses reasoning payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5-mini",
      applyProvider: "azure-openai-responses",
      model: {
        api: "azure-openai-responses",
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
        id: "gpt-5-mini",
        provider: "azure-openai-responses",
      } as unknown as Model<"azure-openai-responses">,
      payload: {
        reasoning: { effort: "none" },
        store: false,
      },
    });
    expect(payload.reasoning).toEqual({ effort: "none" });
  });

  it("injects configured OpenAI service_tier into Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.service_tier).toBe("priority");
  });

  it("injects configured OpenAI text verbosity into Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  textVerbosity: "low",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.text).toEqual({ verbosity: "low" });
  });

  it("injects configured text verbosity into Codex Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai-codex",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": {
                params: {
                  text_verbosity: "high",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
        id: "gpt-5.4",
        provider: "openai-codex",
      } as unknown as Model<"openai-codex-responses">,
      payload: {
        store: false,
        text: {
          verbosity: "medium",
        },
      },
    });
    expect(payload.text).toEqual({ verbosity: "high" });
  });

  it("preserves caller-provided payload.text keys when injecting text verbosity", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  text_verbosity: "medium",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        text: {
          format: { type: "text" },
        },
      },
    });
    expect(payload.text).toEqual({
      format: { type: "text" },
      verbosity: "medium",
    });
  });

  it("preserves caller-provided payload.text.verbosity for OpenAI Responses", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  textVerbosity: "low",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        text: {
          verbosity: "high",
        },
      },
    });
    expect(payload.text).toEqual({ verbosity: "high" });
  });

  it("injects configured OpenAI service_tier into Codex Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai-codex",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        id: "gpt-5.4",
        provider: "openai-codex",
      } as unknown as Model<"openai-codex-responses">,
    });
    expect(payload.service_tier).toBe("priority");
  });

  it("preserves caller-provided service_tier values", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
      payload: {
        service_tier: "default",
        store: false,
      },
    });
    expect(payload.service_tier).toBe("default");
  });

  it("warns and skips invalid OpenAI text verbosity values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyModelId: "gpt-5.4",
        applyProvider: "openai",
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.4": {
                  params: {
                    textVerbosity: "loud",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          id: "gpt-5.4",
          provider: "openai",
        } as unknown as Model<"openai-responses">,
      });
      expect(payload).not.toHaveProperty("text");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid OpenAI text verbosity param: loud");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("lets null runtime override suppress inherited text verbosity injection", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  textVerbosity: "high",
                },
              },
            },
          },
        },
      },
      extraParamsOverride: {
        text_verbosity: null,
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("text");
  });

  it("ignores OpenAI text verbosity params for non-OpenAI providers without warning", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyModelId: "claude-sonnet-4-5",
        applyProvider: "anthropic",
        cfg: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4-5": {
                  params: {
                    textVerbosity: "high",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          id: "claude-sonnet-4-5",
          provider: "anthropic",
        } as unknown as Model<"anthropic-messages">,
        payload: {},
      });
      expect(payload).not.toHaveProperty("text");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("maps fast mode to priority service_tier for direct OpenAI Responses", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  fastMode: true,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
      },
    });
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload.text).toEqual({ verbosity: "low" });
    expect(payload.service_tier).toBe("priority");
  });

  it("preserves caller-provided OpenAI payload fields when fast mode is enabled", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "medium" },
        service_tier: "default",
        text: { verbosity: "high" },
      },
    });
    expect(payload.reasoning).toEqual({ effort: "medium" });
    expect(payload.text).toEqual({ verbosity: "high" });
    expect(payload.service_tier).toBe("default");
  });

  it("maps MiniMax /fast to the matching highspeed model", () => {
    const resolvedModelId = runResolvedModelIdCase({
      applyModelId: "MiniMax-M2.7",
      applyProvider: "minimax",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
        id: "MiniMax-M2.7",
        provider: "minimax",
      } as Model<"anthropic-messages">,
    });

    expect(resolvedModelId).toBe("MiniMax-M2.7-highspeed");
  });

  it("maps MiniMax M2.7 /fast to the matching highspeed model", () => {
    const resolvedModelId = runResolvedModelIdCase({
      applyModelId: "MiniMax-M2.7",
      applyProvider: "minimax",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
        id: "MiniMax-M2.7",
        provider: "minimax",
      } as Model<"anthropic-messages">,
    });

    expect(resolvedModelId).toBe("MiniMax-M2.7-highspeed");
  });

  it("keeps explicit MiniMax highspeed models unchanged when /fast is off", () => {
    const resolvedModelId = runResolvedModelIdCase({
      applyModelId: "MiniMax-M2.7-highspeed",
      applyProvider: "minimax-portal",
      extraParamsOverride: { fastMode: false },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
        id: "MiniMax-M2.7-highspeed",
        provider: "minimax-portal",
      } as unknown as Model<"anthropic-messages">,
    });

    expect(resolvedModelId).toBe("MiniMax-M2.7-highspeed");
  });

  it("maps xAI /fast to the current Grok fast model", () => {
    const resolvedModelId = runResolvedModelIdCase({
      applyModelId: "grok-4",
      applyProvider: "xai",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
        id: "grok-4",
        provider: "xai",
      } as unknown as Model<"openai-completions">,
    });

    expect(resolvedModelId).toBe("grok-4-fast");
  });

  it("keeps explicit xAI fast models unchanged when /fast is off", () => {
    const resolvedModelId = runResolvedModelIdCase({
      applyModelId: "grok-4-1-fast",
      applyProvider: "xai",
      extraParamsOverride: { fastMode: false },
      model: {
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
        id: "grok-4-1-fast",
        provider: "xai",
      } as Model<"openai-completions">,
    });

    expect(resolvedModelId).toBe("grok-4-1-fast");
  });

  it("injects service_tier=auto for Anthropic fast mode on direct API-key models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("auto");
  });

  it("injects service_tier=standard_only for Anthropic fast mode off", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      extraParamsOverride: { fastMode: false },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("preserves caller-provided Anthropic service_tier values", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {
        service_tier: "standard_only",
      },
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("injects configured Anthropic service_tier into direct Anthropic payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                params: {
                  serviceTier: "standard_only",
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("does not inject configured Anthropic service_tier into OAuth-authenticated Anthropic payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                params: {
                  serviceTier: "standard_only",
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      options: {
        apiKey: "sk-ant-oat-test-token",
      },
      payload: {},
    });
    expect(payload.service_tier).toBeUndefined();
  });

  it("does not warn for valid Anthropic serviceTier values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyModelId: "claude-sonnet-4-5",
        applyProvider: "anthropic",
        cfg: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4-5": {
                  params: {
                    serviceTier: "standard_only",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          id: "claude-sonnet-4-5",
          provider: "anthropic",
        } as unknown as Model<"anthropic-messages">,
        payload: {},
      });

      expect(payload.service_tier).toBe("standard_only");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("accepts snake_case Anthropic service_tier params", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      extraParamsOverride: {
        service_tier: "standard_only",
      },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("lets explicit Anthropic service_tier override fast mode defaults", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                params: {
                  fastMode: true,
                  serviceTier: "standard_only",
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("does not inject explicit Anthropic service_tier for OAuth auth even when fast mode is enabled", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                params: {
                  fastMode: true,
                  serviceTier: "standard_only",
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      options: {
        apiKey: "sk-ant-oat-test-token",
      },
      payload: {},
    });
    expect(payload.service_tier).toBeUndefined();
  });

  it("does not inject Anthropic fast mode service_tier for OAuth auth", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      options: {
        apiKey: "sk-ant-oat-test-token",
      },
      payload: {},
    });
    expect(payload.service_tier).toBeUndefined();
  });

  it("does not inject Anthropic standard_only service_tier for OAuth auth when fastMode is false", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      extraParamsOverride: { fastMode: false },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      options: {
        apiKey: "sk-ant-oat-test-token",
      },
      payload: {},
    });
    expect(payload.service_tier).toBeUndefined();
  });

  it("does not inject Anthropic fast mode service_tier for proxied base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://proxy.example.com/anthropic",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not inject explicit Anthropic service_tier for proxied base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "claude-sonnet-4-5",
      applyProvider: "anthropic",
      extraParamsOverride: {
        serviceTier: "standard_only",
      },
      model: {
        api: "anthropic-messages",
        baseUrl: "https://proxy.example.com/anthropic",
        id: "claude-sonnet-4-5",
        provider: "anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("maps fast mode to priority service_tier for openai-codex responses", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai-codex",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        id: "gpt-5.4",
        provider: "openai-codex",
      } as unknown as Model<"openai-codex-responses">,
      payload: {
        store: false,
      },
    });
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload.text).toEqual({ verbosity: "low" });
    expect(payload.service_tier).toBe("priority");
  });

  it("does not inject service_tier for non-openai providers", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "azure-openai-responses",
      cfg: {
        agents: {
          defaults: {
            models: {
              "azure-openai-responses/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        id: "gpt-5.4",
        provider: "azure-openai-responses",
      } as unknown as Model<"azure-openai-responses">,
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not inject service_tier for proxied openai base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not inject service_tier for openai provider routed to Azure base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        id: "gpt-5.4",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("warns and skips service_tier injection for invalid serviceTier values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyModelId: "gpt-5.4",
        applyProvider: "openai",
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.4": {
                  params: {
                    serviceTier: "invalid",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          id: "gpt-5.4",
          provider: "openai",
        } as unknown as Model<"openai-responses">,
      });

      expect(payload).not.toHaveProperty("service_tier");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid OpenAI service tier param: invalid");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for valid OpenAI serviceTier values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyModelId: "gpt-5.4",
        applyProvider: "openai",
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.4": {
                  params: {
                    serviceTier: "priority",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          id: "gpt-5.4",
          provider: "openai",
        } as unknown as Model<"openai-responses">,
      });

      expect(payload.service_tier).toBe("priority");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not force store for OpenAI Responses routed through non-OpenAI base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "openai",
      model: {
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
        id: "gpt-5",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(false);
  });

  it("does not force store for OpenAI Responses when baseUrl is empty", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "openai",
      model: {
        api: "openai-responses",
        baseUrl: "",
        id: "gpt-5",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(false);
  });

  it("strips store from payload for models that declare supportsStore=false", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-4o",
      applyProvider: "azure-openai-responses",
      model: {
        api: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        compat: { supportsStore: false },
        contextWindow: 128_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-4o",
        input: ["text"],
        maxTokens: 16_384,
        name: "gpt-4o",
        provider: "azure-openai-responses",
        reasoning: false,
      } as unknown as Model<"azure-openai-responses">,
    });
    expect(payload).not.toHaveProperty("store");
  });

  it("strips store from payload for non-OpenAI responses providers with supportsStore=false", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gemini-2.5-pro",
      applyProvider: "custom-openai-responses",
      model: {
        api: "openai-responses",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
        compat: { supportsStore: false },
        contextWindow: 1_000_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gemini-2.5-pro",
        input: ["text"],
        maxTokens: 65_536,
        name: "gemini-2.5-pro",
        provider: "custom-openai-responses",
        reasoning: false,
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("store");
  });

  it("keeps existing context_management when stripping store for supportsStore=false models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gemini-2.5-pro",
      applyProvider: "custom-openai-responses",
      model: {
        api: "openai-responses",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
        compat: { supportsStore: false },
        contextWindow: 1_000_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gemini-2.5-pro",
        input: ["text"],
        maxTokens: 65_536,
        name: "gemini-2.5-pro",
        provider: "custom-openai-responses",
        reasoning: false,
      } as unknown as Model<"openai-responses">,
      payload: {
        context_management: [{ compact_threshold: 12_345, type: "compaction" }],
        store: false,
      },
    });
    expect(payload).not.toHaveProperty("store");
    expect(payload.context_management).toEqual([{ compact_threshold: 12_345, type: "compaction" }]);
  });

  it("auto-injects OpenAI Responses context_management compaction for direct OpenAI models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "openai",
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 200_000,
        id: "gpt-5",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.context_management).toEqual([
      {
        compact_threshold: 140_000,
        type: "compaction",
      },
    ]);
  });

  it("does not auto-inject OpenAI Responses context_management for Azure by default", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-4o",
      applyProvider: "azure-openai-responses",
      model: {
        api: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        id: "gpt-4o",
        provider: "azure-openai-responses",
      } as unknown as Model<"azure-openai-responses">,
    });
    expect(payload).not.toHaveProperty("context_management");
  });

  it("allows explicitly enabling OpenAI Responses context_management compaction", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-4o",
      applyProvider: "azure-openai-responses",
      cfg: {
        agents: {
          defaults: {
            models: {
              "azure-openai-responses/gpt-4o": {
                params: {
                  responsesCompactThreshold: 42_000,
                  responsesServerCompaction: true,
                },
              },
            },
          },
        },
      },
      model: {
        api: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        id: "gpt-4o",
        provider: "azure-openai-responses",
      } as unknown as Model<"azure-openai-responses">,
    });
    expect(payload.context_management).toEqual([
      {
        compact_threshold: 42_000,
        type: "compaction",
      },
    ]);
  });

  it("preserves existing context_management payload values", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "openai",
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
      payload: {
        context_management: [{ compact_threshold: 12_345, type: "compaction" }],
        store: false,
      },
    });
    expect(payload.context_management).toEqual([{ compact_threshold: 12_345, type: "compaction" }]);
  });

  it("allows disabling OpenAI Responses context_management compaction via model params", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "openai",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5": {
                params: {
                  responsesServerCompaction: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("context_management");
  });

  it.each([
    {
      name: "with openai-codex provider config",
      run: () =>
        runResponsesPayloadMutationCase({
          applyModelId: "codex-mini-latest",
          applyProvider: "openai-codex",
          model: {
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex/responses",
            id: "codex-mini-latest",
            provider: "openai-codex",
          } as Model<"openai-codex-responses">,
        }),
    },
    {
      name: "without config via provider/model hints",
      run: () =>
        runResponsesPayloadMutationCase({
          applyModelId: "codex-mini-latest",
          applyProvider: "openai-codex",
          model: {
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex/responses",
            id: "codex-mini-latest",
            provider: "openai-codex",
          } as Model<"openai-codex-responses">,
          options: {},
        }),
    },
  ])(
    "does not force store=true for Codex responses (Codex requires store=false) ($name)",
    ({ run }) => {
      expect(run().store).toBe(false);
    },
  );

  it("strips prompt cache fields for non-OpenAI openai-responses endpoints", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "some-model",
      applyProvider: "custom-proxy",
      model: {
        api: "openai-responses",
        baseUrl: "https://my-proxy.example.com/v1",
        id: "some-model",
        provider: "custom-proxy",
      } as unknown as Model<"openai-responses">,
      payload: {
        prompt_cache_key: "session-xyz",
        prompt_cache_retention: "24h",
        store: false,
      },
    });
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  });

  it("keeps prompt cache fields for direct OpenAI openai-responses endpoints", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "openai",
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
      payload: {
        prompt_cache_key: "session-123",
        prompt_cache_retention: "24h",
        store: false,
      },
    });
    expect(payload.prompt_cache_key).toBe("session-123");
    expect(payload.prompt_cache_retention).toBe("24h");
  });

  it("keeps prompt cache fields for direct Azure OpenAI azure-openai-responses endpoints", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-4o",
      applyProvider: "azure-openai-responses",
      model: {
        api: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        id: "gpt-4o",
        provider: "azure-openai-responses",
      } as unknown as Model<"azure-openai-responses">,
      payload: {
        prompt_cache_key: "session-azure",
        prompt_cache_retention: "24h",
        store: false,
      },
    });
    expect(payload.prompt_cache_key).toBe("session-azure");
    expect(payload.prompt_cache_retention).toBe("24h");
  });

  it("keeps prompt cache fields when openai-responses baseUrl is omitted", () => {
    const payload = runResponsesPayloadMutationCase({
      applyModelId: "gpt-5",
      applyProvider: "openai",
      model: {
        api: "openai-responses",
        id: "gpt-5",
        provider: "openai",
      } as unknown as Model<"openai-responses">,
      payload: {
        prompt_cache_key: "session-default",
        prompt_cache_retention: "24h",
        store: false,
      },
    });
    expect(payload.prompt_cache_key).toBe("session-default");
    expect(payload.prompt_cache_retention).toBe("24h");
  });
});
