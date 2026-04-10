import Anthropic from "@anthropic-ai/sdk";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  type AnthropicOptions,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  calculateCost,
  getEnvApiKey,
  parseStreamingJson,
} from "@mariozechner/pi-ai";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "./anthropic-payload-policy.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { transformTransportMessages } from "./transport-message-transform.js";
import {
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

const CLAUDE_CODE_VERSION = "2.1.75";
const CLAUDE_CODE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
] as const;
const CLAUDE_CODE_TOOL_LOOKUP = new Map(
  CLAUDE_CODE_TOOLS.map((tool) => [normalizeLowercaseStringOrEmpty(tool), tool]),
);

type AnthropicTransportModel = Model<"anthropic-messages"> & {
  headers?: Record<string, string>;
  provider: string;
};

type AnthropicTransportOptions = AnthropicOptions &
  Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets">;

type TransportContentBlock =
  | { type: "text"; text: string; index?: number }
  | {
      type: "thinking";
      thinking: string;
      thinkingSignature: string;
      redacted?: boolean;
      index?: number;
    }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: unknown;
      partialJson?: string;
      index?: number;
    };

interface MutableAssistantOutput {
  role: "assistant";
  content: TransportContentBlock[];
  api: "anthropic-messages";
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
}

function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4.6") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

function mapThinkingLevelToEffort(
  level: ThinkingLevel,
  modelId: string,
): NonNullable<AnthropicOptions["effort"]> {
  switch (level) {
    case "minimal":
    case "low": {
      return "low";
    }
    case "medium": {
      return "medium";
    }
    case "xhigh": {
      return modelId.includes("opus-4-6") || modelId.includes("opus-4.6") ? "max" : "high";
    }
    default: {
      return "high";
    }
  }
}

function clampReasoningLevel(level: ThinkingLevel): "minimal" | "low" | "medium" | "high" {
  return level === "xhigh" ? "high" : level;
}

function adjustMaxTokensForThinking(params: {
  baseMaxTokens: number;
  modelMaxTokens: number;
  reasoningLevel: ThinkingLevel;
  customBudgets?: SimpleStreamOptions["thinkingBudgets"];
}): { maxTokens: number; thinkingBudget: number } {
  const budgets = {
    high: 16_384,
    low: 2048,
    medium: 8192,
    minimal: 1024,
    ...params.customBudgets,
  };
  const minOutputTokens = 1024;
  const level = clampReasoningLevel(params.reasoningLevel);
  let thinkingBudget = budgets[level];
  const maxTokens = Math.min(params.baseMaxTokens + thinkingBudget, params.modelMaxTokens);
  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }
  return { maxTokens, thinkingBudget };
}

function isAnthropicOAuthToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}

function toClaudeCodeName(name: string): string {
  return CLAUDE_CODE_TOOL_LOOKUP.get(normalizeLowercaseStringOrEmpty(name)) ?? name;
}

function fromClaudeCodeName(name: string, tools: Context["tools"] | undefined): string {
  if (tools && tools.length > 0) {
    const lowerName = normalizeLowercaseStringOrEmpty(name);
    const matchedTool = tools.find(
      (tool) => normalizeLowercaseStringOrEmpty(tool.name) === lowerName,
    );
    if (matchedTool) {
      return matchedTool.name;
    }
  }
  return name;
}

function convertContentBlocks(
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[],
) {
  const hasImages = content.some((item) => item.type === "image");
  if (!hasImages) {
    return sanitizeTransportPayloadText(
      content.map((item) => ("text" in item ? item.text : "")).join("\n"),
    );
  }
  const blocks = content.map((block) => {
    if (block.type === "text") {
      return {
        text: sanitizeTransportPayloadText(block.text),
        type: "text",
      };
    }
    return {
      source: {
        data: block.data,
        media_type: block.mimeType,
        type: "base64",
      },
      type: "image",
    };
  });
  if (!blocks.some((block) => block.type === "text")) {
    blocks.unshift({
      text: "(see attached image)",
      type: "text",
    });
  }
  return blocks;
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertAnthropicMessages(
  messages: Context["messages"],
  model: AnthropicTransportModel,
  isOAuthToken: boolean,
) {
  const params: Record<string, unknown>[] = [];
  const transformedMessages = transformTransportMessages(messages, model, normalizeToolCallId);
  for (let i = 0; i < transformedMessages.length; i += 1) {
    const msg = transformedMessages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({
            content: sanitizeTransportPayloadText(msg.content),
            role: "user",
          });
        }
        continue;
      }
      const blocks: (| { type: "text"; text: string }
        | {
            type: "image";
            source: { type: "base64"; media_type: string; data: string };
          })[] = msg.content.map((item) =>
        item.type === "text"
          ? {
              text: sanitizeTransportPayloadText(item.text),
              type: "text",
            }
          : {
              source: {
                data: item.data,
                media_type: item.mimeType,
                type: "base64",
              },
              type: "image",
            },
      );
      let filteredBlocks = model.input.includes("image")
        ? blocks
        : blocks.filter((block) => block.type !== "image");
      filteredBlocks = filteredBlocks.filter(
        (block) => block.type !== "text" || block.text.trim().length > 0,
      );
      if (filteredBlocks.length === 0) {
        continue;
      }
      params.push({
        content: filteredBlocks,
        role: "user",
      });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            blocks.push({
              text: sanitizeTransportPayloadText(block.text),
              type: "text",
            });
          }
          continue;
        }
        if (block.type === "thinking") {
          if (block.redacted) {
            blocks.push({
              data: block.thinkingSignature,
              type: "redacted_thinking",
            });
            continue;
          }
          if (block.thinking.trim().length === 0) {
            continue;
          }
          if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
            blocks.push({
              text: sanitizeTransportPayloadText(block.thinking),
              type: "text",
            });
          } else {
            blocks.push({
              signature: block.thinkingSignature,
              thinking: sanitizeTransportPayloadText(block.thinking),
              type: "thinking",
            });
          }
          continue;
        }
        if (block.type === "toolCall") {
          blocks.push({
            id: block.id,
            input: block.arguments ?? {},
            name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
            type: "tool_use",
          });
        }
      }
      if (blocks.length > 0) {
        params.push({
          content: blocks,
          role: "assistant",
        });
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const toolResult = msg;
      const toolResults: Record<string, unknown>[] = [
        {
          content: convertContentBlocks(toolResult.content),
          is_error: toolResult.isError,
          tool_use_id: toolResult.toolCallId,
          type: "tool_result",
        },
      ];
      let j = i + 1;
      while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
        const nextMsg = transformedMessages[j] as Extract<
          Context["messages"][number],
          { role: "toolResult" }
        >;
        toolResults.push({
          content: convertContentBlocks(nextMsg.content),
          is_error: nextMsg.isError,
          tool_use_id: nextMsg.toolCallId,
          type: "tool_result",
        });
        j += 1;
      }
      i = j - 1;
      params.push({
        content: toolResults,
        role: "user",
      });
    }
  }
  return params;
}

function convertAnthropicTools(tools: Context["tools"], isOAuthToken: boolean) {
  if (!tools) {
    return [];
  }
  return tools.map((tool) => ({
    description: tool.description,
    input_schema: {
      properties: tool.parameters.properties || {},
      required: tool.parameters.required || [],
      type: "object",
    },
    name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
  }));
}

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case "end_turn": {
      return "stop";
    }
    case "max_tokens": {
      return "length";
    }
    case "tool_use": {
      return "toolUse";
    }
    case "pause_turn": {
      return "stop";
    }
    case "refusal":
    case "sensitive": {
      return "error";
    }
    case "stop_sequence": {
      return "stop";
    }
    default: {
      throw new Error(`Unhandled stop reason: ${String(reason)}`);
    }
  }
}

function createAnthropicTransportClient(params: {
  model: AnthropicTransportModel;
  context: Context;
  apiKey: string;
  options: AnthropicTransportOptions | undefined;
}) {
  const { model, context, apiKey, options } = params;
  const needsInterleavedBeta =
    (options?.interleavedThinking ?? true) && !supportsAdaptiveThinking(model.id);
  const fetch = buildGuardedModelFetch(model);
  if (model.provider === "github-copilot") {
    const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
    return {
      client: new Anthropic({
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        defaultHeaders: mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
          },
          model.headers,
          buildCopilotDynamicHeaders({
            hasImages: hasCopilotVisionInput(context.messages),
            messages: context.messages,
          }),
          options?.headers,
        ),
        fetch,
      }),
      isOAuthToken: false,
    };
  }
  const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
  if (needsInterleavedBeta) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }
  if (isAnthropicOAuthToken(apiKey)) {
    return {
      client: new Anthropic({
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        defaultHeaders: mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
            "anthropic-dangerous-direct-browser-access": "true",
            "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
            "x-app": "cli",
          },
          model.headers,
          options?.headers,
        ),
        fetch,
      }),
      isOAuthToken: true,
    };
  }
  return {
    client: new Anthropic({
      apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeTransportHeaders(
        {
          accept: "application/json",
          "anthropic-beta": betaFeatures.join(","),
          "anthropic-dangerous-direct-browser-access": "true",
        },
        model.headers,
        options?.headers,
      ),
      fetch,
    }),
    isOAuthToken: false,
  };
}

function buildAnthropicParams(
  model: AnthropicTransportModel,
  context: Context,
  isOAuthToken: boolean,
  options: AnthropicTransportOptions | undefined,
) {
  const payloadPolicy = resolveAnthropicPayloadPolicy({
    api: model.api,
    baseUrl: model.baseUrl,
    cacheRetention: options?.cacheRetention,
    enableCacheControl: true,
    provider: model.provider,
  });
  const defaultMaxTokens = Math.min(model.maxTokens, 32_000);
  const params: Record<string, unknown> = {
    max_tokens: options?.maxTokens || defaultMaxTokens,
    messages: convertAnthropicMessages(context.messages, model, isOAuthToken),
    model: model.id,
    stream: true,
  };
  if (isOAuthToken) {
    params.system = [
      {
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        type: "text",
      },
      ...(context.systemPrompt
        ? [
            {
              text: sanitizeTransportPayloadText(context.systemPrompt),
              type: "text",
            },
          ]
        : []),
    ];
  } else if (context.systemPrompt) {
    params.system = [
      {
        text: sanitizeTransportPayloadText(context.systemPrompt),
        type: "text",
      },
    ];
  }
  if (options?.temperature !== undefined && !options.thinkingEnabled) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertAnthropicTools(context.tools, isOAuthToken);
  }
  if (model.reasoning) {
    if (options?.thinkingEnabled) {
      if (supportsAdaptiveThinking(model.id)) {
        params.thinking = { type: "adaptive" };
        if (options.effort) {
          params.output_config = { effort: options.effort };
        }
      } else {
        params.thinking = {
          budget_tokens: options.thinkingBudgetTokens || 1024,
          type: "enabled",
        };
      }
    } else if (options?.thinkingEnabled === false) {
      params.thinking = { type: "disabled" };
    }
  }
  if (options?.metadata && typeof options.metadata.user_id === "string") {
    params.metadata = { user_id: options.metadata.user_id };
  }
  if (options?.toolChoice) {
    params.tool_choice =
      typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice;
  }
  applyAnthropicPayloadPolicyToParams(params, payloadPolicy);
  return params;
}

function resolveAnthropicTransportOptions(
  model: AnthropicTransportModel,
  options: AnthropicTransportOptions | undefined,
  apiKey: string,
): AnthropicTransportOptions {
  const baseMaxTokens = options?.maxTokens || Math.min(model.maxTokens, 32_000);
  const resolved: AnthropicTransportOptions = {
    apiKey,
    cacheRetention: options?.cacheRetention,
    headers: options?.headers,
    interleavedThinking: options?.interleavedThinking,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    maxTokens: baseMaxTokens,
    metadata: options?.metadata,
    onPayload: options?.onPayload,
    reasoning: options?.reasoning,
    sessionId: options?.sessionId,
    signal: options?.signal,
    temperature: options?.temperature,
    thinkingBudgets: options?.thinkingBudgets,
    toolChoice: options?.toolChoice,
  };
  if (!options?.reasoning) {
    resolved.thinkingEnabled = false;
    return resolved;
  }
  if (supportsAdaptiveThinking(model.id)) {
    resolved.thinkingEnabled = true;
    resolved.effort = mapThinkingLevelToEffort(options.reasoning, model.id);
    return resolved;
  }
  const adjusted = adjustMaxTokensForThinking({
    baseMaxTokens,
    customBudgets: options.thinkingBudgets,
    modelMaxTokens: model.maxTokens,
    reasoningLevel: options.reasoning,
  });
  resolved.maxTokens = adjusted.maxTokens;
  resolved.thinkingEnabled = true;
  resolved.thinkingBudgetTokens = adjusted.thinkingBudget;
  return resolved;
}

export function createAnthropicMessagesTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as AnthropicTransportModel;
    const options = rawOptions as AnthropicTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output: MutableAssistantOutput = {
        api: "anthropic-messages",
        content: [],
        model: model.id,
        provider: model.provider,
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: createEmptyTransportUsage(),
      };
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const transportOptions = resolveAnthropicTransportOptions(model, options, apiKey);
        const { client, isOAuthToken } = createAnthropicTransportClient({
          apiKey,
          context,
          model,
          options: transportOptions,
        });
        let params = buildAnthropicParams(model, context, isOAuthToken, transportOptions);
        const nextParams = await transportOptions.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as Record<string, unknown>;
        }
        const anthropicStream = client.messages.stream(
          { ...params, stream: true } as never,
          transportOptions.signal ? { signal: transportOptions.signal } : undefined,
        ) as AsyncIterable<Record<string, unknown>>;
        stream.push({ partial: output as never, type: "start" });
        const blocks = output.content;
        for await (const event of anthropicStream) {
          if (event.type === "message_start") {
            const message = event.message as
              | { id?: string; usage?: Record<string, unknown> }
              | undefined;
            const usage = message?.usage ?? {};
            output.responseId = typeof message?.id === "string" ? message.id : undefined;
            output.usage.input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
            output.usage.output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
            output.usage.cacheRead =
              typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
            output.usage.cacheWrite =
              typeof usage.cache_creation_input_tokens === "number"
                ? usage.cache_creation_input_tokens
                : 0;
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
            continue;
          }
          if (event.type === "content_block_start") {
            const contentBlock = event.content_block as Record<string, unknown> | undefined;
            const index = typeof event.index === "number" ? event.index : -1;
            if (contentBlock?.type === "text") {
              const block: TransportContentBlock = { index, text: "", type: "text" };
              output.content.push(block);
              stream.push({
                contentIndex: output.content.length - 1,
                partial: output as never,
                type: "text_start",
              });
              continue;
            }
            if (contentBlock?.type === "thinking") {
              const block: TransportContentBlock = {
                index,
                thinking: "",
                thinkingSignature: "",
                type: "thinking",
              };
              output.content.push(block);
              stream.push({
                contentIndex: output.content.length - 1,
                partial: output as never,
                type: "thinking_start",
              });
              continue;
            }
            if (contentBlock?.type === "redacted_thinking") {
              const block: TransportContentBlock = {
                index,
                redacted: true,
                thinking: "[Reasoning redacted]",
                thinkingSignature: typeof contentBlock.data === "string" ? contentBlock.data : "",
                type: "thinking",
              };
              output.content.push(block);
              stream.push({
                contentIndex: output.content.length - 1,
                partial: output as never,
                type: "thinking_start",
              });
              continue;
            }
            if (contentBlock?.type === "tool_use") {
              const block: TransportContentBlock = {
                arguments:
                  contentBlock.input && typeof contentBlock.input === "object"
                    ? (contentBlock.input as Record<string, unknown>)
                    : {},
                id: typeof contentBlock.id === "string" ? contentBlock.id : "",
                index,
                name:
                  typeof contentBlock.name === "string"
                    ? (isOAuthToken
                      ? fromClaudeCodeName(contentBlock.name, context.tools)
                      : contentBlock.name)
                    : "",
                partialJson: "",
                type: "toolCall",
              };
              output.content.push(block);
              stream.push({
                contentIndex: output.content.length - 1,
                partial: output as never,
                type: "toolcall_start",
              });
            }
            continue;
          }
          if (event.type === "content_block_delta") {
            const index = blocks.findIndex((block) => block.index === event.index);
            const block = blocks[index];
            const delta = event.delta as Record<string, unknown> | undefined;
            if (
              block?.type === "text" &&
              delta?.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              block.text += delta.text;
              stream.push({
                contentIndex: index,
                delta: delta.text,
                partial: output as never,
                type: "text_delta",
              });
              continue;
            }
            if (
              block?.type === "thinking" &&
              delta?.type === "thinking_delta" &&
              typeof delta.thinking === "string"
            ) {
              block.thinking += delta.thinking;
              stream.push({
                contentIndex: index,
                delta: delta.thinking,
                partial: output as never,
                type: "thinking_delta",
              });
              continue;
            }
            if (
              block?.type === "toolCall" &&
              delta?.type === "input_json_delta" &&
              typeof delta.partial_json === "string"
            ) {
              block.partialJson += delta.partial_json;
              block.arguments = parseStreamingJson(block.partialJson);
              stream.push({
                contentIndex: index,
                delta: delta.partial_json,
                partial: output as never,
                type: "toolcall_delta",
              });
              continue;
            }
            if (
              block?.type === "thinking" &&
              delta?.type === "signature_delta" &&
              typeof delta.signature === "string"
            ) {
              block.thinkingSignature = `${String(block.thinkingSignature ?? "")}${delta.signature}`;
            }
            continue;
          }
          if (event.type === "content_block_stop") {
            const index = blocks.findIndex((block) => block.index === event.index);
            const block = blocks[index];
            if (!block) {
              continue;
            }
            delete block.index;
            if (block.type === "text") {
              stream.push({
                content: block.text,
                contentIndex: index,
                partial: output as never,
                type: "text_end",
              });
              continue;
            }
            if (block.type === "thinking") {
              stream.push({
                content: block.thinking,
                contentIndex: index,
                partial: output as never,
                type: "thinking_end",
              });
              continue;
            }
            if (block.type === "toolCall") {
              if (typeof block.partialJson === "string" && block.partialJson.length > 0) {
                block.arguments = parseStreamingJson(block.partialJson);
              }
              delete block.partialJson;
              stream.push({
                contentIndex: index,
                partial: output as never,
                toolCall: block as never,
                type: "toolcall_end",
              });
            }
            continue;
          }
          if (event.type === "message_delta") {
            const delta = event.delta as { stop_reason?: string } | undefined;
            const usage = event.usage as Record<string, unknown> | undefined;
            if (delta?.stop_reason) {
              output.stopReason = mapStopReason(delta.stop_reason);
            }
            if (typeof usage?.input_tokens === "number") {
              output.usage.input = usage.input_tokens;
            }
            if (typeof usage?.output_tokens === "number") {
              output.usage.output = usage.output_tokens;
            }
            if (typeof usage?.cache_read_input_tokens === "number") {
              output.usage.cacheRead = usage.cache_read_input_tokens;
            }
            if (typeof usage?.cache_creation_input_tokens === "number") {
              output.usage.cacheWrite = usage.cache_creation_input_tokens;
            }
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
          }
        }
        finalizeTransportStream({ output, signal: transportOptions.signal, stream });
      } catch (error) {
        failTransportStream({
          cleanup: () => {
            for (const block of output.content) {
              delete block.index;
            }
          },
          error,
          output,
          signal: options?.signal,
          stream,
        });
      }
    })();
    return eventStream as ReturnType<StreamFn>;
  };
}
