import type { AssistantMessage, StopReason, Usage } from "@mariozechner/pi-ai";

export interface StreamModelDescriptor {
  api: string;
  provider: string;
  id: string;
}

export function buildZeroUsage(): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  };
}

export function buildUsageWithNoCost(params: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}): Usage {
  const input = params.input ?? 0;
  const output = params.output ?? 0;
  const cacheRead = params.cacheRead ?? 0;
  const cacheWrite = params.cacheWrite ?? 0;
  return {
    cacheRead,
    cacheWrite,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input,
    output,
    totalTokens: params.totalTokens ?? input + output,
  };
}

export function buildAssistantMessage(params: {
  model: StreamModelDescriptor;
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage: Usage;
  timestamp?: number;
}): AssistantMessage {
  return {
    api: params.model.api,
    content: params.content,
    model: params.model.id,
    provider: params.model.provider,
    role: "assistant",
    stopReason: params.stopReason,
    timestamp: params.timestamp ?? Date.now(),
    usage: params.usage,
  };
}

export function buildAssistantMessageWithZeroUsage(params: {
  model: StreamModelDescriptor;
  content: AssistantMessage["content"];
  stopReason: StopReason;
  timestamp?: number;
}): AssistantMessage {
  return buildAssistantMessage({
    content: params.content,
    model: params.model,
    stopReason: params.stopReason,
    timestamp: params.timestamp,
    usage: buildZeroUsage(),
  });
}

export function buildStreamErrorAssistantMessage(params: {
  model: StreamModelDescriptor;
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage & { stopReason: "error"; errorMessage: string } {
  return {
    ...buildAssistantMessageWithZeroUsage({
      content: [],
      model: params.model,
      stopReason: "error",
      timestamp: params.timestamp,
    }),
    errorMessage: params.errorMessage,
    stopReason: "error",
  };
}
