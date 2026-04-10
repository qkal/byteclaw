import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  calculateCost,
  getEnvApiKey,
} from "@mariozechner/pi-ai";
import { parseGeminiAuth } from "../infra/gemini-auth.js";
import { normalizeGoogleApiBaseUrl } from "../infra/google-api-base-url.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";
import { transformTransportMessages } from "./transport-message-transform.js";
import {
  type WritableTransportStream,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

type GoogleTransportModel = Model<"google-generative-ai"> & {
  headers?: Record<string, string>;
  provider: string;
};

type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

type GoogleTransportOptions = SimpleStreamOptions & {
  cachedContent?: string;
  toolChoice?:
    | "auto"
    | "none"
    | "any"
    | "required"
    | {
        type: "function";
        function: {
          name: string;
        };
      };
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    level?: GoogleThinkingLevel;
  };
};

interface GoogleGenerateContentRequest {
  cachedContent?: string;
  contents: Record<string, unknown>[];
  generationConfig?: Record<string, unknown>;
  systemInstruction?: Record<string, unknown>;
  tools?: Record<string, unknown>[];
  toolConfig?: Record<string, unknown>;
}

type GoogleTransportContentBlock =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

interface MutableAssistantOutput {
  role: "assistant";
  content: GoogleTransportContentBlock[];
  api: "google-generative-ai";
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

interface GoogleSseChunk {
  responseId?: string;
  candidates?: {
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        thoughtSignature?: string;
        functionCall?: {
          id?: string;
          name?: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

let toolCallCounter = 0;

function isGemini3ProModel(modelId: string): boolean {
  return /gemini-3(?:\.\d+)?-pro/.test(normalizeLowercaseStringOrEmpty(modelId));
}

function isGemini3FlashModel(modelId: string): boolean {
  return /gemini-3(?:\.\d+)?-flash/.test(normalizeLowercaseStringOrEmpty(modelId));
}

function requiresToolCallId(modelId: string): boolean {
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const match = normalizeLowercaseStringOrEmpty(modelId).match(/^gemini(?:-live)?-(\d+)/);
  if (!match) {
    return true;
  }
  return Number.parseInt(match[1] ?? "", 10) >= 3;
}

function retainThoughtSignature(existing: string | undefined, incoming: string | undefined) {
  if (typeof incoming === "string" && incoming.length > 0) {
    return incoming;
  }
  return existing;
}

function mapToolChoice(
  choice: GoogleTransportOptions["toolChoice"],
): { mode: "AUTO" | "NONE" | "ANY"; allowedFunctionNames?: string[] } | undefined {
  if (!choice) {
    return undefined;
  }
  if (typeof choice === "object" && choice.type === "function") {
    return { allowedFunctionNames: [choice.function.name], mode: "ANY" };
  }
  switch (choice) {
    case "none": {
      return { mode: "NONE" };
    }
    case "any":
    case "required": {
      return { mode: "ANY" };
    }
    default: {
      return { mode: "AUTO" };
    }
  }
}

function mapStopReasonString(reason: string): "stop" | "length" | "error" {
  switch (reason) {
    case "STOP": {
      return "stop";
    }
    case "MAX_TOKENS": {
      return "length";
    }
    default: {
      return "error";
    }
  }
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function resolveGoogleModelPath(modelId: string): string {
  if (modelId.startsWith("models/") || modelId.startsWith("tunedModels/")) {
    return modelId;
  }
  return `models/${modelId}`;
}

function buildGoogleRequestUrl(model: GoogleTransportModel): string {
  const baseUrl = normalizeGoogleApiBaseUrl(model.baseUrl);
  return `${baseUrl}/${resolveGoogleModelPath(model.id)}:streamGenerateContent?alt=sse`;
}

function resolveThinkingLevel(level: ThinkingLevel, modelId: string): GoogleThinkingLevel {
  if (isGemini3ProModel(modelId)) {
    switch (level) {
      case "minimal":
      case "low": {
        return "LOW";
      }
      case "medium":
      case "high":
      case "xhigh": {
        return "HIGH";
      }
    }
  }
  switch (level) {
    case "minimal": {
      return "MINIMAL";
    }
    case "low": {
      return "LOW";
    }
    case "medium": {
      return "MEDIUM";
    }
    case "high":
    case "xhigh": {
      return "HIGH";
    }
  }
}

function getDisabledThinkingConfig(modelId: string): Record<string, unknown> {
  if (isGemini3ProModel(modelId)) {
    return { thinkingLevel: "LOW" };
  }
  if (isGemini3FlashModel(modelId)) {
    return { thinkingLevel: "MINIMAL" };
  }
  return { thinkingBudget: 0 };
}

function getGoogleThinkingBudget(
  modelId: string,
  effort: ThinkingLevel,
  customBudgets?: GoogleTransportOptions["thinkingBudgets"],
): number | undefined {
  const normalizedEffort = effort === "xhigh" ? "high" : effort;
  if (customBudgets?.[normalizedEffort] !== undefined) {
    return customBudgets[normalizedEffort];
  }
  if (modelId.includes("2.5-pro")) {
    return { high: 32_768, low: 2048, medium: 8192, minimal: 128 }[normalizedEffort];
  }
  if (modelId.includes("2.5-flash")) {
    return { high: 24_576, low: 2048, medium: 8192, minimal: 128 }[normalizedEffort];
  }
  return undefined;
}

function resolveGoogleThinkingConfig(
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
): Record<string, unknown> | undefined {
  if (!model.reasoning) {
    return undefined;
  }
  if (options?.thinking) {
    if (!options.thinking.enabled) {
      return getDisabledThinkingConfig(model.id);
    }
    const config: Record<string, unknown> = { includeThoughts: true };
    if (options.thinking.level) {
      config.thinkingLevel = options.thinking.level;
    } else if (typeof options.thinking.budgetTokens === "number") {
      config.thinkingBudget = options.thinking.budgetTokens;
    }
    return config;
  }
  if (!options?.reasoning) {
    return getDisabledThinkingConfig(model.id);
  }
  if (isGemini3ProModel(model.id) || isGemini3FlashModel(model.id)) {
    return {
      includeThoughts: true,
      thinkingLevel: resolveThinkingLevel(options.reasoning, model.id),
    };
  }
  const budget = getGoogleThinkingBudget(model.id, options.reasoning, options.thinkingBudgets);
  return {
    includeThoughts: true,
    ...(typeof budget === "number" ? { thinkingBudget: budget } : {}),
  };
}

function convertGoogleMessages(model: GoogleTransportModel, context: Context) {
  const contents: Record<string, unknown>[] = [];
  const transformedMessages = transformTransportMessages(context.messages, model, (id) =>
    requiresToolCallId(model.id) ? normalizeToolCallId(id) : id,
  );
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({
          parts: [{ text: sanitizeTransportPayloadText(msg.content) }],
          role: "user",
        });
        continue;
      }
      const parts = msg.content
        .map((item) =>
          item.type === "text"
            ? { text: sanitizeTransportPayloadText(item.text) }
            : {
                inlineData: {
                  data: item.data,
                  mimeType: item.mimeType,
                },
              },
        )
        .filter((item) => model.input.includes("image") || !("inlineData" in item));
      if (parts.length > 0) {
        contents.push({ parts, role: "user" });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
      const parts: Record<string, unknown>[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text.trim()) {
            continue;
          }
          parts.push({
            text: sanitizeTransportPayloadText(block.text),
            ...(isSameProviderAndModel && block.textSignature
              ? { thoughtSignature: block.textSignature }
              : {}),
          });
          continue;
        }
        if (block.type === "thinking") {
          if (!block.thinking.trim()) {
            continue;
          }
          if (isSameProviderAndModel) {
            parts.push({
              text: sanitizeTransportPayloadText(block.thinking),
              thought: true,
              ...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
            });
          } else {
            parts.push({ text: sanitizeTransportPayloadText(block.thinking) });
          }
          continue;
        }
        if (block.type === "toolCall") {
          parts.push({
            functionCall: {
              args: block.arguments ?? {},
              name: block.name,
              ...(requiresToolCallId(model.id) ? { id: block.id } : {}),
            },
            ...(isSameProviderAndModel && block.thoughtSignature
              ? { thoughtSignature: block.thoughtSignature }
              : {}),
          });
        }
      }
      if (parts.length > 0) {
        contents.push({ parts, role: "model" });
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter(
          (item): item is Extract<(typeof msg.content)[number], { type: "text" }> =>
            item.type === "text",
        )
        .map((item) => item.text)
        .join("\n");
      const imageContent = model.input.includes("image")
        ? msg.content.filter(
            (item): item is Extract<(typeof msg.content)[number], { type: "image" }> =>
              item.type === "image",
          )
        : [];
      const responseValue = textResult
        ? sanitizeTransportPayloadText(textResult)
        : imageContent.length > 0
          ? "(see attached image)"
          : "";
      const imageParts = imageContent.map((imageBlock) => ({
        inlineData: {
          data: imageBlock.data,
          mimeType: imageBlock.mimeType,
        },
      }));
      const functionResponse = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
          ...(supportsMultimodalFunctionResponse(model.id) && imageParts.length > 0
            ? { parts: imageParts }
            : {}),
          ...(requiresToolCallId(model.id) ? { id: msg.toolCallId } : {}),
        },
      };
      const last = contents[contents.length - 1];
      if (
        last?.role === "user" &&
        Array.isArray(last.parts) &&
        last.parts.some((part) => "functionResponse" in part)
      ) {
        (last.parts as Record<string, unknown>[]).push(functionResponse);
      } else {
        contents.push({ parts: [functionResponse], role: "user" });
      }
      if (imageParts.length > 0 && !supportsMultimodalFunctionResponse(model.id)) {
        contents.push({ parts: [{ text: "Tool result image:" }, ...imageParts], role: "user" });
      }
    }
  }
  return contents;
}

function convertGoogleTools(tools: NonNullable<Context["tools"]>) {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        description: tool.description,
        name: tool.name,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

export function buildGoogleGenerativeAiParams(
  model: GoogleTransportModel,
  context: Context,
  options?: GoogleTransportOptions,
): GoogleGenerateContentRequest {
  const generationConfig: Record<string, unknown> = {};
  if (typeof options?.temperature === "number") {
    generationConfig.temperature = options.temperature;
  }
  if (typeof options?.maxTokens === "number") {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  const thinkingConfig = resolveGoogleThinkingConfig(model, options);
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const params: GoogleGenerateContentRequest = {
    contents: convertGoogleMessages(model, context),
  };
  if (typeof options?.cachedContent === "string" && options.cachedContent.trim()) {
    params.cachedContent = options.cachedContent.trim();
  }
  if (Object.keys(generationConfig).length > 0) {
    params.generationConfig = generationConfig;
  }
  if (context.systemPrompt) {
    params.systemInstruction = {
      parts: [
        {
          text: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)),
        },
      ],
    };
  }
  if (context.tools?.length) {
    params.tools = convertGoogleTools(context.tools);
    const toolChoice = mapToolChoice(options?.toolChoice);
    if (toolChoice) {
      params.toolConfig = {
        functionCallingConfig: toolChoice,
      };
    }
  }
  return params;
}

function buildGoogleHeaders(
  model: GoogleTransportModel,
  apiKey: string | undefined,
  optionHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const authHeaders = apiKey ? parseGeminiAuth(apiKey).headers : undefined;
  return (
    mergeTransportHeaders(
      {
        accept: "text/event-stream",
      },
      authHeaders,
      model.headers,
      optionHeaders,
    ) ?? {
      accept: "text/event-stream",
    }
  );
}

async function* parseGoogleSseChunks(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<GoogleSseChunk> {
  if (!response.body) {
    throw new Error("No response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abortHandler = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortHandler);
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") {
          continue;
        }
        yield JSON.parse(data) as GoogleSseChunk;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
}

function updateUsage(
  output: MutableAssistantOutput,
  model: GoogleTransportModel,
  chunk: GoogleSseChunk,
) {
  const usage = chunk.usageMetadata;
  if (!usage) {
    return;
  }
  const promptTokens = usage.promptTokenCount || 0;
  const cacheRead = usage.cachedContentTokenCount || 0;
  output.usage = {
    cacheRead,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: Math.max(0, promptTokens - cacheRead),
    output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    totalTokens: usage.totalTokenCount || 0,
  };
  calculateCost(model, output.usage);
}

function pushTextBlockEnd(
  stream: WritableTransportStream,
  output: MutableAssistantOutput,
  blockIndex: number,
) {
  const block = output.content[blockIndex];
  if (!block) {
    return;
  }
  if (block.type === "thinking") {
    stream.push({
      content: block.thinking,
      contentIndex: blockIndex,
      partial: output as never,
      type: "thinking_end",
    });
    return;
  }
  if (block.type === "text") {
    stream.push({
      content: block.text,
      contentIndex: blockIndex,
      partial: output as never,
      type: "text_end",
    });
  }
}

export function createGoogleGenerativeAiTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as GoogleTransportModel;
    const options = rawOptions as GoogleTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output: MutableAssistantOutput = {
        api: "google-generative-ai",
        content: [],
        model: model.id,
        provider: model.provider,
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: createEmptyTransportUsage(),
      };
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? undefined;
        const fetch = buildGuardedModelFetch(model);
        let params = buildGoogleGenerativeAiParams(model, context, options);
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as GoogleGenerateContentRequest;
        }
        const response = await fetch(buildGoogleRequestUrl(model), {
          body: JSON.stringify(params),
          headers: buildGoogleHeaders(model, apiKey, options?.headers),
          method: "POST",
          signal: options?.signal,
        });
        if (!response.ok) {
          const message = await response.text().catch(() => "");
          throw new Error(`Google Generative AI API error (${response.status}): ${message}`);
        }
        stream.push({ partial: output as never, type: "start" });
        let currentBlockIndex = -1;
        for await (const chunk of parseGoogleSseChunks(response, options?.signal)) {
          output.responseId ||= chunk.responseId;
          updateUsage(output, model, chunk);
          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (typeof part.text === "string") {
                const isThinking = part.thought === true;
                const currentBlock = output.content[currentBlockIndex];
                if (
                  currentBlockIndex < 0 ||
                  !currentBlock ||
                  (isThinking && currentBlock.type !== "thinking") ||
                  (!isThinking && currentBlock.type !== "text")
                ) {
                  if (currentBlockIndex >= 0) {
                    pushTextBlockEnd(stream, output, currentBlockIndex);
                  }
                  if (isThinking) {
                    output.content.push({ thinking: "", type: "thinking" });
                    currentBlockIndex = output.content.length - 1;
                    stream.push({
                      contentIndex: currentBlockIndex,
                      partial: output as never,
                      type: "thinking_start",
                    });
                  } else {
                    output.content.push({ text: "", type: "text" });
                    currentBlockIndex = output.content.length - 1;
                    stream.push({
                      contentIndex: currentBlockIndex,
                      partial: output as never,
                      type: "text_start",
                    });
                  }
                }
                const activeBlock = output.content[currentBlockIndex];
                if (activeBlock?.type === "thinking") {
                  activeBlock.thinking += part.text;
                  activeBlock.thinkingSignature = retainThoughtSignature(
                    activeBlock.thinkingSignature,
                    part.thoughtSignature,
                  );
                  stream.push({
                    contentIndex: currentBlockIndex,
                    delta: part.text,
                    partial: output as never,
                    type: "thinking_delta",
                  });
                } else if (activeBlock?.type === "text") {
                  activeBlock.text += part.text;
                  activeBlock.textSignature = retainThoughtSignature(
                    activeBlock.textSignature,
                    part.thoughtSignature,
                  );
                  stream.push({
                    contentIndex: currentBlockIndex,
                    delta: part.text,
                    partial: output as never,
                    type: "text_delta",
                  });
                }
              }
              if (part.functionCall) {
                if (currentBlockIndex >= 0) {
                  pushTextBlockEnd(stream, output, currentBlockIndex);
                  currentBlockIndex = -1;
                }
                const providedId = part.functionCall.id;
                const isDuplicate = output.content.some(
                  (block) => block.type === "toolCall" && block.id === providedId,
                );
                const toolCallId =
                  providedId && !isDuplicate
                    ? providedId
                    : `${part.functionCall.name || "tool"}_${Date.now()}_${++toolCallCounter}`;
                const toolCall: GoogleTransportContentBlock = {
                  arguments: part.functionCall.args ?? {},
                  id: toolCallId,
                  name: part.functionCall.name || "",
                  type: "toolCall",
                };
                output.content.push(toolCall);
                const blockIndex = output.content.length - 1;
                stream.push({
                  contentIndex: blockIndex,
                  partial: output as never,
                  type: "toolcall_start",
                });
                stream.push({
                  contentIndex: blockIndex,
                  delta: JSON.stringify(toolCall.arguments),
                  partial: output as never,
                  type: "toolcall_delta",
                });
                stream.push({
                  contentIndex: blockIndex,
                  partial: output as never,
                  toolCall,
                  type: "toolcall_end",
                });
              }
            }
          }
          if (typeof candidate?.finishReason === "string") {
            output.stopReason = mapStopReasonString(candidate.finishReason);
            if (output.content.some((block) => block.type === "toolCall")) {
              output.stopReason = "toolUse";
            }
          }
        }
        if (currentBlockIndex >= 0) {
          pushTextBlockEnd(stream, output, currentBlockIndex);
        }
        finalizeTransportStream({ output, signal: options?.signal, stream });
      } catch (error) {
        failTransportStream({ error, output, signal: options?.signal, stream });
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}
