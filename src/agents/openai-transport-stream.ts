import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  type Api,
  type Context,
  type Model,
  calculateCost,
  createAssistantMessageEventStream,
  getEnvApiKey,
  parseStreamingJson,
} from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/openai-completions";
import OpenAI, { AzureOpenAI } from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses.js";
import { resolveProviderTransportTurnStateWithPlugin } from "../plugins/provider-runtime.js";
import type { ProviderRuntimeModel } from "../plugins/types.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { flattenCompletionMessagesToStringContent } from "./openai-completions-string-content.js";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";
import {
  normalizeOpenAIStrictToolParameters,
  resolveOpenAIStrictToolFlagForInventory,
  resolveOpenAIStrictToolSetting,
} from "./openai-tool-schema.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";
import { transformTransportMessages } from "./transport-message-transform.js";
import { mergeTransportMetadata, sanitizeTransportPayloadText } from "./transport-stream-shared.js";

const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";

type OpenAIReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

interface BaseStreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  cacheRetention?: "none" | "short" | "long";
  sessionId?: string;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown;
  headers?: Record<string, string>;
}

type OpenAIResponsesOptions = BaseStreamOptions & {
  reasoning?: OpenAIReasoningEffort;
  reasoningEffort?: OpenAIReasoningEffort;
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
};

type OpenAICompletionsOptions = BaseStreamOptions & {
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | {
        type: "function";
        function: {
          name: string;
        };
      };
  reasoning?: OpenAIReasoningEffort;
  reasoningEffort?: OpenAIReasoningEffort;
};

type OpenAIModeModel = Model<Api> & {
  compat?: Record<string, unknown>;
};

interface MutableAssistantOutput {
  role: "assistant";
  content: Record<string, unknown>[];
  api: Api;
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

export { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

function stringifyUnknown(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function stringifyJsonLike(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function getServiceTierCostMultiplier(serviceTier: ResponseCreateParamsStreaming["service_tier"]) {
  switch (serviceTier) {
    case "flex": {
      return 0.5;
    }
    case "priority": {
      return 2;
    }
    default: {
      return 1;
    }
  }
}

function applyServiceTierPricing(
  usage: MutableAssistantOutput["usage"],
  serviceTier?: ResponseCreateParamsStreaming["service_tier"],
): void {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export function resolveAzureOpenAIApiVersion(env = process.env): string {
  return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function encodeTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  return JSON.stringify({ id, v: 1, ...(phase ? { phase } : {}) });
}

function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: "commentary" | "final_answer" } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1 && typeof parsed.id === "string") {
        return parsed.phase === "commentary" || parsed.phase === "final_answer"
          ? { id: parsed.id, phase: parsed.phase }
          : { id: parsed.id };
      }
    } catch {
      // Keep legacy plain-string behavior below.
    }
  }
  return { id: signature };
}

function convertResponsesMessages(
  model: Model<Api>,
  context: Context,
  allowedToolCallProviders: Set<string>,
  options?: { includeSystemPrompt?: boolean; supportsDeveloperRole?: boolean },
): ResponseInput {
  const messages: ResponseInput = [];
  const normalizeIdPart = (part: string) => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };
  const buildForeignResponsesItemId = (itemId: string) => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model<Api>,
    source: { provider: string; api: Api },
  ) => {
    if (!allowedToolCallProviders.has(model.provider)) {
      return normalizeIdPart(id);
    }
    if (!id.includes("|")) {
      return normalizeIdPart(id);
    }
    const [callId, itemId] = id.split("|");
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId)
      : normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const transformedMessages = transformTransportMessages(
    context.messages,
    model,
    normalizeToolCallId,
  );
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push({
      content: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)),
      role: model.reasoning && options?.supportsDeveloperRole !== false ? "developer" : "system",
    });
  }
  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          content: [{ text: sanitizeTransportPayloadText(msg.content), type: "input_text" }],
          role: "user",
        });
      } else {
        const content = (
          msg.content.map((item) =>
            item.type === "text"
              ? { text: sanitizeTransportPayloadText(item.text), type: "input_text" }
              : {
                  detail: "auto",
                  image_url: `data:${item.mimeType};base64,${item.data}`,
                  type: "input_image",
                },
          ) as ResponseInputMessageContentList
        ).filter((item) => model.input.includes("image") || item.type !== "input_image");
        if (content.length > 0) {
          messages.push({ content, role: "user" });
        }
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      const isDifferentModel =
        msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            output.push(JSON.parse(block.thinkingSignature));
          }
        } else if (block.type === "text") {
          let msgId = parseTextSignature(block.textSignature)?.id ?? `msg_${msgIndex}`;
          if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            content: [
              {
                annotations: [],
                text: sanitizeTransportPayloadText(block.text),
                type: "output_text",
              },
            ],
            id: msgId,
            phase: parseTextSignature(block.textSignature)?.phase,
            role: "assistant",
            status: "completed",
            type: "message",
          });
        } else if (block.type === "toolCall") {
          const [callId, itemIdRaw] = block.id.split("|");
          const itemId = isDifferentModel && itemIdRaw?.startsWith("fc_") ? undefined : itemIdRaw;
          output.push({
            arguments: JSON.stringify(block.arguments),
            call_id: callId,
            id: itemId,
            name: block.name,
            type: "function_call",
          });
        }
      }
      if (output.length > 0) {
        messages.push(...output);
      }
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const hasImages = msg.content.some((item) => item.type === "image");
      const [callId] = msg.toolCallId.split("|");
      messages.push({
        call_id: callId,
        output:
          hasImages && model.input.includes("image")
            ? ([
                ...(textResult
                  ? [{ text: sanitizeTransportPayloadText(textResult), type: "input_text" }]
                  : []),
                ...msg.content
                  .filter((item) => item.type === "image")
                  .map((item) => ({
                    detail: "auto",
                    image_url: `data:${item.mimeType};base64,${item.data}`,
                    type: "input_image",
                  })),
              ] as ResponseFunctionCallOutputItemList)
            : sanitizeTransportPayloadText(textResult || "(see attached image)"),
        type: "function_call_output",
      });
    }
    msgIndex += 1;
  }
  return messages;
}

function convertResponsesTools(
  tools: NonNullable<Context["tools"]>,
  options?: { strict?: boolean | null },
): FunctionTool[] {
  const strict = resolveOpenAIStrictToolFlagForInventory(tools, options?.strict);
  if (strict === undefined) {
    return tools.map((tool) => ({
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
      type: "function",
    })) as unknown as FunctionTool[];
  }
  return tools.map((tool) => ({
    description: tool.description,
    name: tool.name,
    parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict),
    strict,
    type: "function",
  }));
}

async function processResponsesStream(
  openaiStream: AsyncIterable<unknown>,
  output: MutableAssistantOutput,
  stream: { push(event: unknown): void },
  model: Model<Api>,
  options?: {
    serviceTier?: ResponseCreateParamsStreaming["service_tier"];
    applyServiceTierPricing?: (
      usage: MutableAssistantOutput["usage"],
      serviceTier?: ResponseCreateParamsStreaming["service_tier"],
    ) => void;
  },
) {
  let currentItem: Record<string, unknown> | null = null;
  let currentBlock: Record<string, unknown> | null = null;
  const blockIndex = () => output.content.length - 1;
  for await (const rawEvent of openaiStream) {
    const event = rawEvent as Record<string, unknown>;
    const type = stringifyUnknown(event.type);
    if (type === "response.created") {
      output.responseId = stringifyUnknown((event.response as { id?: string } | undefined)?.id);
    } else if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { thinking: "", type: "thinking" };
        output.content.push(currentBlock);
        stream.push({ contentIndex: blockIndex(), partial: output, type: "thinking_start" });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { text: "", type: "text" };
        output.content.push(currentBlock);
        stream.push({ contentIndex: blockIndex(), partial: output, type: "text_start" });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          arguments: {},
          id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
          name: stringifyUnknown(item.name),
          partialJson: stringifyJsonLike(item.arguments),
          type: "toolCall",
        };
        output.content.push(currentBlock);
        stream.push({ contentIndex: blockIndex(), partial: output, type: "toolcall_start" });
      }
    } else if (type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = `${stringifyUnknown(currentBlock.thinking)}${stringifyUnknown(event.delta)}`;
        stream.push({
          contentIndex: blockIndex(),
          delta: stringifyUnknown(event.delta),
          partial: output,
          type: "thinking_delta",
        });
      }
    } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = `${stringifyUnknown(currentBlock.text)}${stringifyUnknown(event.delta)}`;
        stream.push({
          contentIndex: blockIndex(),
          delta: stringifyUnknown(event.delta),
          partial: output,
          type: "text_delta",
        });
      }
    } else if (type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson = `${stringifyJsonLike(currentBlock.partialJson)}${stringifyJsonLike(event.delta)}`;
        currentBlock.arguments = parseStreamingJson(stringifyJsonLike(currentBlock.partialJson));
        stream.push({
          contentIndex: blockIndex(),
          delta: stringifyJsonLike(event.delta),
          partial: output,
          type: "toolcall_delta",
        });
      }
    } else if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        const summary = Array.isArray(item.summary)
          ? item.summary.map((part) => String((part as { text?: string }).text ?? "")).join("\n\n")
          : "";
        currentBlock.thinking = summary;
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          content: stringifyUnknown(currentBlock.thinking),
          contentIndex: blockIndex(),
          partial: output,
          type: "thinking_end",
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        const content = Array.isArray(item.content) ? item.content : [];
        currentBlock.text = content
          .map((part) =>
            (part as { type?: string; text?: string; refusal?: string }).type === "output_text"
              ? String((part as { text?: string }).text ?? "")
              : String((part as { refusal?: string }).refusal ?? ""),
          )
          .join("");
        currentBlock.textSignature = encodeTextSignatureV1(
          stringifyUnknown(item.id),
          (item.phase as "commentary" | "final_answer" | undefined) ?? undefined,
        );
        stream.push({
          content: stringifyUnknown(currentBlock.text),
          contentIndex: blockIndex(),
          partial: output,
          type: "text_end",
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const args =
          currentBlock?.type === "toolCall" && currentBlock.partialJson
            ? parseStreamingJson(stringifyJsonLike(currentBlock.partialJson, "{}"))
            : parseStreamingJson(stringifyJsonLike(item.arguments, "{}"));
        stream.push({
          contentIndex: blockIndex(),
          partial: output,
          toolCall: {
            arguments: args,
            id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
            name: stringifyUnknown(item.name),
            type: "toolCall",
          },
          type: "toolcall_end",
        });
        currentBlock = null;
      }
    } else if (type === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") {
        output.responseId = response.id;
      }
      const usage = response?.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
            service_tier?: ResponseCreateParamsStreaming["service_tier"];
            status?: string;
          }
        | undefined;
      if (usage) {
        const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          cacheRead: cachedTokens,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: (usage.input_tokens || 0) - cachedTokens,
          output: usage.output_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        };
      }
      calculateCost(model as never, output.usage as never);
      if (options?.applyServiceTierPricing) {
        options.applyServiceTierPricing(
          output.usage,
          (response?.service_tier as ResponseCreateParamsStreaming["service_tier"] | undefined) ??
            options.serviceTier,
        );
      }
      output.stopReason = mapResponsesStopReason(response?.status as string | undefined);
      if (
        output.content.some((block) => block.type === "toolCall") &&
        output.stopReason === "stop"
      ) {
        output.stopReason = "toolUse";
      }
    } else if (type === "error") {
      throw new Error(
        `Error Code ${stringifyUnknown(event.code, "unknown")}: ${stringifyUnknown(event.message, "Unknown error")}`,
      );
    } else if (type === "response.failed") {
      const response = event.response as
        | {
            error?: { code?: string; message?: string };
            incomplete_details?: { reason?: string };
          }
        | undefined;
      const msg = response?.error
        ? `${response.error.code || "unknown"}: ${response.error.message || "no message"}`
        : response?.incomplete_details?.reason
          ? `incomplete: ${response.incomplete_details.reason}`
          : "Unknown error (no error details in response)";
      throw new Error(msg);
    }
  }
}

function mapResponsesStopReason(status: string | undefined): string {
  if (!status) {
    return "stop";
  }
  switch (status) {
    case "completed": {
      return "stop";
    }
    case "incomplete": {
      return "length";
    }
    case "failed":
    case "cancelled": {
      return "error";
    }
    case "in_progress":
    case "queued": {
      return "stop";
    }
    default: {
      throw new Error(`Unhandled stop reason: ${status}`);
    }
  }
}

function buildOpenAIClientHeaders(
  model: Model<Api>,
  context: Context,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
): Record<string, string> {
  const headers = { ...model.headers };
  if (model.provider === "github-copilot") {
    Object.assign(
      headers,
      buildCopilotDynamicHeaders({
        hasImages: hasCopilotVisionInput(context.messages),
        messages: context.messages,
      }),
    );
  }
  if (optionHeaders) {
    Object.assign(headers, optionHeaders);
  }
  if (turnHeaders) {
    Object.assign(headers, turnHeaders);
  }
  return headers;
}

function resolveProviderTransportTurnState(
  model: Model<Api>,
  params: {
    sessionId?: string;
    turnId: string;
    attempt: number;
    transport: "stream" | "websocket";
  },
) {
  return resolveProviderTransportTurnStateWithPlugin({
    context: {
      attempt: params.attempt,
      model: model as ProviderRuntimeModel,
      modelId: model.id,
      provider: model.provider,
      sessionId: params.sessionId,
      transport: params.transport,
      turnId: params.turnId,
    },
    provider: model.provider,
  });
}

function createOpenAIResponsesClient(
  model: Model<Api>,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
) {
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
    fetch: buildGuardedModelFetch(model),
  });
}

export function createOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        api: model.api,
        content: [],
        model: model.id,
        provider: model.provider,
        role: "assistant" as const,
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const turnState = resolveProviderTransportTurnState(model, {
          attempt: 1,
          sessionId: options?.sessionId,
          transport: "stream",
          turnId: randomUUID(),
        });
        const client = createOpenAIResponsesClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
        );
        let params = buildOpenAIResponsesParams(
          model,
          context,
          options as OpenAIResponsesOptions,
          turnState?.metadata,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        params = mergeTransportMetadata(params, turnState?.metadata);
        const responseStream = (await client.responses.create(
          params as never,
          options?.signal ? { signal: options.signal } : undefined,
        )) as unknown as AsyncIterable<unknown>;
        stream.push({ partial: output as never, type: "start" });
        await processResponsesStream(responseStream, output, stream, model, {
          applyServiceTierPricing,
          serviceTier: (options as OpenAIResponsesOptions | undefined)?.serviceTier,
        });
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ message: output as never, reason: output.stopReason as never, type: "done" });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ error: output as never, reason: output.stopReason as never, type: "error" });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

function resolveCacheRetention(cacheRetention: string | undefined): "short" | "long" | "none" {
  if (cacheRetention === "short" || cacheRetention === "long" || cacheRetention === "none") {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

function getPromptCacheRetention(
  baseUrl: string | undefined,
  cacheRetention: "short" | "long" | "none",
) {
  if (cacheRetention !== "long") {
    return undefined;
  }
  return baseUrl?.includes("api.openai.com") ? "24h" : undefined;
}

function resolveOpenAIReasoningEffort(options: OpenAIResponsesOptions | undefined) {
  return options?.reasoningEffort ?? options?.reasoning ?? "high";
}

export function buildOpenAIResponsesParams(
  model: Model<Api>,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  metadata?: Record<string, string>,
) {
  const compat = getCompat(model as OpenAIModeModel);
  const supportsDeveloperRole =
    typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : undefined;
  const messages = convertResponsesMessages(
    model,
    context,
    new Set(["openai", "openai-codex", "opencode", "azure-openai-responses"]),
    { supportsDeveloperRole },
  );
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, {
    storeMode: "disable",
  });
  const params: OpenAIResponsesRequestParams = {
    input: messages,
    model: model.id,
    prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
    prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
    stream: true,
    ...(metadata ? { metadata } : {}),
  };
  if (options?.maxTokens) {
    params.max_output_tokens = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.serviceTier !== undefined && payloadPolicy.allowsServiceTier) {
    params.service_tier = options.serviceTier;
  }
  if (context.tools) {
    params.tools = convertResponsesTools(context.tools, {
      strict: resolveOpenAIStrictToolSetting(model as OpenAIModeModel, {
        transport: "stream",
      }),
    });
  }
  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoning || options?.reasoningSummary) {
      params.reasoning = {
        effort: resolveOpenAIReasoningEffort(options),
        summary: options?.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.provider !== "github-copilot") {
      params.reasoning = { effort: "high", summary: "auto" };
      params.include = ["reasoning.encrypted_content"];
    }
  }
  applyOpenAIResponsesPayloadPolicy(params as Record<string, unknown>, payloadPolicy);
  return params;
}

export function createAzureOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        api: "azure-openai-responses",
        content: [],
        model: model.id,
        provider: model.provider,
        role: "assistant" as const,
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const turnState = resolveProviderTransportTurnState(model, {
          attempt: 1,
          sessionId: options?.sessionId,
          transport: "stream",
          turnId: randomUUID(),
        });
        const client = createAzureOpenAIClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
        );
        const deploymentName = resolveAzureDeploymentName(model);
        let params = buildAzureOpenAIResponsesParams(
          model,
          context,
          options as OpenAIResponsesOptions | undefined,
          deploymentName,
          turnState?.metadata,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        params = mergeTransportMetadata(params, turnState?.metadata);
        const responseStream = (await client.responses.create(
          params as never,
          options?.signal ? { signal: options.signal } : undefined,
        )) as unknown as AsyncIterable<unknown>;
        stream.push({ partial: output as never, type: "start" });
        await processResponsesStream(responseStream, output, stream, model);
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ message: output as never, reason: output.stopReason as never, type: "done" });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ error: output as never, reason: output.stopReason as never, type: "error" });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

function normalizeAzureBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveAzureDeploymentName(model: Model<Api>): string {
  const deploymentMap = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  if (deploymentMap) {
    for (const entry of deploymentMap.split(",")) {
      const [modelId, deploymentName] = entry.split("=", 2).map((value) => value?.trim());
      if (modelId === model.id && deploymentName) {
        return deploymentName;
      }
    }
  }
  return model.id;
}

function createAzureOpenAIClient(
  model: Model<Api>,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
) {
  return new AzureOpenAI({
    apiKey,
    apiVersion: resolveAzureOpenAIApiVersion(),
    baseURL: normalizeAzureBaseUrl(model.baseUrl),
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
    fetch: buildGuardedModelFetch(model),
  });
}

function buildAzureOpenAIResponsesParams(
  model: Model<Api>,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  deploymentName: string,
  metadata?: Record<string, string>,
) {
  const params = buildOpenAIResponsesParams(model, context, options, metadata);
  params.model = deploymentName;
  delete params.store;
  return params;
}

function hasToolHistory(messages: Context["messages"]): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" ||
      (message.role === "assistant" && message.content.some((block) => block.type === "toolCall")),
  );
}

function createOpenAICompletionsClient(
  model: Model<Api>,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
) {
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders),
    fetch: buildGuardedModelFetch(model),
  });
}

export function createOpenAICompletionsTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        api: model.api,
        content: [],
        model: model.id,
        provider: model.provider,
        role: "assistant" as const,
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const client = createOpenAICompletionsClient(model, context, apiKey, options?.headers);
        let params = buildOpenAICompletionsParams(
          model as OpenAIModeModel,
          context,
          options as OpenAICompletionsOptions | undefined,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        const responseStream = (await client.chat.completions.create(params as never, {
          signal: options?.signal,
        })) as unknown as AsyncIterable<ChatCompletionChunk>;
        stream.push({ partial: output as never, type: "start" });
        await processOpenAICompletionsStream(responseStream, output, model, stream);
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        stream.push({ message: output as never, reason: output.stopReason as never, type: "done" });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ error: output as never, reason: output.stopReason as never, type: "error" });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

async function processOpenAICompletionsStream(
  responseStream: AsyncIterable<ChatCompletionChunk>,
  output: MutableAssistantOutput,
  model: Model<Api>,
  stream: { push(event: unknown): void },
) {
  let currentBlock:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; thinkingSignature?: string }
    | {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        partialArgs: string;
      }
    | null = null;
  const blockIndex = () => output.content.length - 1;
  const finishCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }
    if (currentBlock.type === "toolCall") {
      currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
      const completed = {
        ...currentBlock,
        arguments: parseStreamingJson(currentBlock.partialArgs),
      };
      output.content[blockIndex()] = completed;
    }
  };
  for await (const chunk of responseStream) {
    output.responseId ||= chunk.id;
    if (chunk.usage) {
      output.usage = parseTransportChunkUsage(chunk.usage, model);
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      continue;
    }
    const choiceUsage = (choice as unknown as { usage?: ChatCompletionChunk["usage"] }).usage;
    if (!chunk.usage && choiceUsage) {
      output.usage = parseTransportChunkUsage(choiceUsage, model);
    }
    if (choice.finish_reason) {
      const finishReasonResult = mapStopReason(choice.finish_reason);
      output.stopReason = finishReasonResult.stopReason;
      if (finishReasonResult.errorMessage) {
        output.errorMessage = finishReasonResult.errorMessage;
      }
    }
    if (!choice.delta) {
      continue;
    }
    if (choice.delta.content) {
      if (!currentBlock || currentBlock.type !== "text") {
        finishCurrentBlock();
        currentBlock = { text: "", type: "text" };
        output.content.push(currentBlock);
        stream.push({ contentIndex: blockIndex(), partial: output, type: "text_start" });
      }
      currentBlock.text += choice.delta.content;
      stream.push({
        contentIndex: blockIndex(),
        delta: choice.delta.content,
        partial: output,
        type: "text_delta",
      });
      continue;
    }
    const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
    const reasoningField = reasoningFields.find((field) => {
      const value = (choice.delta as Record<string, unknown>)[field];
      return typeof value === "string" && value.length > 0;
    });
    if (reasoningField) {
      if (!currentBlock || currentBlock.type !== "thinking") {
        finishCurrentBlock();
        currentBlock = { thinking: "", thinkingSignature: reasoningField, type: "thinking" };
        output.content.push(currentBlock);
        stream.push({ contentIndex: blockIndex(), partial: output, type: "thinking_start" });
      }
      currentBlock.thinking += String((choice.delta as Record<string, unknown>)[reasoningField]);
      stream.push({
        contentIndex: blockIndex(),
        delta: String((choice.delta as Record<string, unknown>)[reasoningField]),
        partial: output,
        type: "thinking_delta",
      });
      continue;
    }
    if (choice.delta.tool_calls) {
      for (const toolCall of choice.delta.tool_calls) {
        if (
          !currentBlock ||
          currentBlock.type !== "toolCall" ||
          (toolCall.id && currentBlock.id !== toolCall.id)
        ) {
          finishCurrentBlock();
          currentBlock = {
            arguments: {},
            id: toolCall.id || "",
            name: toolCall.function?.name || "",
            partialArgs: "",
            type: "toolCall",
          };
          output.content.push(currentBlock);
          stream.push({ contentIndex: blockIndex(), partial: output, type: "toolcall_start" });
        }
        if (currentBlock.type !== "toolCall") {
          continue;
        }
        if (toolCall.id) {
          currentBlock.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          currentBlock.name = toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          currentBlock.partialArgs += toolCall.function.arguments;
          currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
          stream.push({
            contentIndex: blockIndex(),
            delta: toolCall.function.arguments,
            partial: output,
            type: "toolcall_delta",
          });
        }
      }
    }
  }
  finishCurrentBlock();
}

function detectCompat(model: OpenAIModeModel) {
  const { provider } = model;
  const { capabilities, defaults: compatDefaults } = detectOpenAICompletionsCompat(model);
  const { endpointClass } = capabilities;
  const isDefaultRoute = endpointClass === "default";
  const isGroq = endpointClass === "groq-native" || (isDefaultRoute && provider === "groq");
  const reasoningEffortMap: Record<string, string> =
    isGroq && model.id === "qwen/qwen3-32b"
      ? {
          high: "default",
          low: "default",
          medium: "default",
          minimal: "default",
          xhigh: "default",
        }
      : {};
  return {
    maxTokensField: compatDefaults.maxTokensField,
    openRouterRouting: {},
    reasoningEffortMap,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresToolResultName: false,
    supportsDeveloperRole: compatDefaults.supportsDeveloperRole,
    supportsReasoningEffort: compatDefaults.supportsReasoningEffort,
    supportsStore: compatDefaults.supportsStore,
    supportsStrictMode: compatDefaults.supportsStrictMode,
    supportsUsageInStreaming: compatDefaults.supportsUsageInStreaming,
    thinkingFormat: compatDefaults.thinkingFormat,
    vercelGatewayRouting: {},
  };
}

function getCompat(model: OpenAIModeModel): {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  reasoningEffortMap: Record<string, string>;
  supportsUsageInStreaming: boolean;
  maxTokensField: string;
  requiresToolResultName: boolean;
  requiresAssistantAfterToolResult: boolean;
  requiresThinkingAsText: boolean;
  thinkingFormat: string;
  openRouterRouting: Record<string, unknown>;
  vercelGatewayRouting: Record<string, unknown>;
  supportsStrictMode: boolean;
  requiresStringContent: boolean;
} {
  const detected = detectCompat(model);
  const compat = model.compat ?? {};
  const supportsStore =
    typeof compat.supportsStore === "boolean" ? compat.supportsStore : detected.supportsStore;
  const supportsReasoningEffort =
    typeof compat.supportsReasoningEffort === "boolean"
      ? compat.supportsReasoningEffort
      : detected.supportsReasoningEffort;
  return {
    maxTokensField: (compat.maxTokensField as string | undefined) ?? detected.maxTokensField,
    openRouterRouting: (compat.openRouterRouting as Record<string, unknown> | undefined) ?? {},
    reasoningEffortMap:
      (compat.reasoningEffortMap as Record<string, string> | undefined) ??
      detected.reasoningEffortMap,
    requiresAssistantAfterToolResult:
      (compat.requiresAssistantAfterToolResult as boolean | undefined) ??
      detected.requiresAssistantAfterToolResult,
    requiresStringContent: (compat.requiresStringContent as boolean | undefined) ?? false,
    requiresThinkingAsText:
      (compat.requiresThinkingAsText as boolean | undefined) ?? detected.requiresThinkingAsText,
    requiresToolResultName:
      (compat.requiresToolResultName as boolean | undefined) ?? detected.requiresToolResultName,
    supportsDeveloperRole:
      (compat.supportsDeveloperRole as boolean | undefined) ?? detected.supportsDeveloperRole,
    supportsReasoningEffort,
    supportsStore,
    supportsStrictMode:
      (compat.supportsStrictMode as boolean | undefined) ?? detected.supportsStrictMode,
    supportsUsageInStreaming:
      (compat.supportsUsageInStreaming as boolean | undefined) ?? detected.supportsUsageInStreaming,
    thinkingFormat: (compat.thinkingFormat as string | undefined) ?? detected.thinkingFormat,
    vercelGatewayRouting:
      (compat.vercelGatewayRouting as Record<string, unknown> | undefined) ??
      detected.vercelGatewayRouting,
  };
}

interface OpenAIResponsesRequestParams {
  model: string;
  input: ResponseInput;
  stream: true;
  prompt_cache_key?: string;
  prompt_cache_retention?: "24h";
  metadata?: Record<string, string>;
  store?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  service_tier?: ResponseCreateParamsStreaming["service_tier"];
  tools?: FunctionTool[];
  reasoning?:
    | { effort: "none" }
    | {
        effort: NonNullable<OpenAIResponsesOptions["reasoningEffort"]>;
        summary: NonNullable<OpenAIResponsesOptions["reasoningSummary"]>;
      };
  include?: string[];
}

function mapReasoningEffort(effort: string, reasoningEffortMap: Record<string, string>): string {
  return reasoningEffortMap[effort] ?? effort;
}

function resolveOpenAICompletionsReasoningEffort(options: OpenAICompletionsOptions | undefined) {
  return options?.reasoningEffort ?? options?.reasoning ?? "high";
}

function convertTools(
  tools: NonNullable<Context["tools"]>,
  compat: ReturnType<typeof getCompat>,
  model: OpenAIModeModel,
) {
  const strict = resolveOpenAIStrictToolFlagForInventory(
    tools,
    resolveOpenAIStrictToolSetting(model, {
      supportsStrictMode: compat?.supportsStrictMode,
      transport: "stream",
    }),
  );
  return tools.map((tool) => ({
    function: {
      description: tool.description,
      name: tool.name,
      parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict === true),
      ...(strict === undefined ? {} : { strict }),
    },
    type: "function",
  }));
}

export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
) {
  const compat = getCompat(model);
  const completionsContext = context.systemPrompt
    ? {
        ...context,
        systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
      }
    : context;
  const messages = convertMessages(model as never, completionsContext, compat as never);
  const params: Record<string, unknown> = {
    messages: compat.requiresStringContent
      ? flattenCompletionMessagesToStringContent(messages)
      : messages,
    model: model.id,
    stream: true,
  };
  if (compat.supportsUsageInStreaming) {
    params.stream_options = { include_usage: true };
  }
  if (compat.supportsStore) {
    params.store = false;
  }
  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      params.max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertTools(context.tools, compat, model);
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }
  const completionsReasoningEffort = resolveOpenAICompletionsReasoningEffort(options);
  if (compat.thinkingFormat === "openrouter" && model.reasoning && completionsReasoningEffort) {
    params.reasoning = {
      effort: mapReasoningEffort(completionsReasoningEffort, compat.reasoningEffortMap),
    };
  } else if (completionsReasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    params.reasoning_effort = mapReasoningEffort(
      completionsReasoningEffort,
      compat.reasoningEffortMap,
    );
  }
  return params;
}

export function parseTransportChunkUsage(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]>,
  model: Model<Api>,
) {
  const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
  const promptTokens = rawUsage.prompt_tokens || 0;
  const input = Math.max(0, promptTokens - cachedTokens);
  const outputTokens = rawUsage.completion_tokens || 0;
  const usage = {
    cacheRead: cachedTokens,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input,
    output: outputTokens,
    totalTokens: input + outputTokens + cachedTokens,
  };
  calculateCost(model as never, usage as never);
  return usage;
}

function mapStopReason(reason: string | null) {
  if (reason === null) {
    return { stopReason: "stop" };
  }
  switch (reason) {
    case "stop":
    case "end": {
      return { stopReason: "stop" };
    }
    case "length": {
      return { stopReason: "length" };
    }
    case "function_call":
    case "tool_calls": {
      return { stopReason: "toolUse" };
    }
    case "content_filter": {
      return { errorMessage: "Provider finish_reason: content_filter", stopReason: "error" };
    }
    case "network_error": {
      return { errorMessage: "Provider finish_reason: network_error", stopReason: "error" };
    }
    default: {
      return {
        errorMessage: `Provider finish_reason: ${reason}`,
        stopReason: "error",
      };
    }
  }
}
