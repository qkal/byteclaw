import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { ZERO_USAGE_FIXTURE } from "./usage-fixtures.js";

export function castAgentMessage(message: unknown): AgentMessage {
  return message as AgentMessage;
}

export function castAgentMessages(messages: unknown[]): AgentMessage[] {
  return messages as AgentMessage[];
}

export function makeAgentUserMessage(
  overrides: Partial<UserMessage> & Pick<UserMessage, "content">,
): UserMessage {
  return {
    role: "user",
    timestamp: 0,
    ...overrides,
  };
}

export function makeAgentAssistantMessage(
  overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "content">,
): AssistantMessage {
  return {
    api: "openai-responses",
    model: "test-model",
    provider: "openai",
    role: "assistant",
    stopReason: "stop",
    timestamp: 0,
    usage: ZERO_USAGE_FIXTURE,
    ...overrides,
  };
}

export function makeAgentToolResultMessage(
  overrides: Partial<ToolResultMessage> &
    Pick<ToolResultMessage, "toolCallId" | "toolName" | "content">,
): ToolResultMessage {
  const { toolCallId, toolName, content, ...rest } = overrides;
  return {
    content,
    isError: false,
    role: "toolResult",
    timestamp: 0,
    toolCallId,
    toolName,
    ...rest,
  };
}
