import type { AssistantMessage } from "@mariozechner/pi-ai";
import { ZERO_USAGE_FIXTURE } from "./usage-fixtures.js";

export function makeAssistantMessageFixture(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  const errorText = typeof overrides.errorMessage === "string" ? overrides.errorMessage : "error";
  return {
    api: "openai-responses",
    content: [{ text: errorText, type: "text" }],
    errorMessage: errorText,
    model: "test-model",
    provider: "openai",
    role: "assistant",
    stopReason: "error",
    timestamp: 0,
    usage: ZERO_USAGE_FIXTURE,
    ...overrides,
  };
}
