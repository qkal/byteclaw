import type { AssistantMessage, Model, ToolResultMessage } from "@mariozechner/pi-ai";
import { streamOpenAIResponses } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

function buildModel(): Model<"openai-responses"> {
  return {
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: "gpt-5.4",
    input: ["text"],
    maxTokens: 4096,
    name: "gpt-5.4",
    provider: "openai",
    reasoning: true,
  };
}

function extractInput(payload: Record<string, unknown> | undefined) {
  return Array.isArray(payload?.input) ? payload.input : [];
}

function extractInputTypes(input: unknown[]) {
  return input
    .map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>).type : undefined,
    )
    .filter((t): t is string => typeof t === "string");
}

function extractInputMessages(input: unknown[]) {
  return input.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).type === "message",
  );
}

const ZERO_USAGE = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
} as const;

function buildReasoningPart(id = "rs_test") {
  return {
    thinking: "internal",
    thinkingSignature: JSON.stringify({
      id,
      summary: [],
      type: "reasoning",
    }),
    type: "thinking" as const,
  };
}

function buildAssistantMessage(params: {
  stopReason: AssistantMessage["stopReason"];
  content: AssistantMessage["content"];
}): AssistantMessage {
  return {
    api: "openai-responses",
    content: params.content,
    model: "gpt-5.4",
    provider: "openai",
    role: "assistant",
    stopReason: params.stopReason,
    timestamp: Date.now(),
    usage: ZERO_USAGE,
  };
}

async function runAbortedOpenAIResponsesStream(params: {
  messages: (AssistantMessage | ToolResultMessage | { role: "user"; content: string; timestamp: number })[];
  tools?: {
    name: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
  }[];
}) {
  const controller = new AbortController();
  controller.abort();
  let payload: Record<string, unknown> | undefined;

  const stream = streamOpenAIResponses(
    buildModel(),
    {
      messages: params.messages,
      systemPrompt: "system",
      ...(params.tools ? { tools: params.tools } : {}),
    },
    {
      apiKey: "test",
      onPayload: (nextPayload) => {
        payload = nextPayload as Record<string, unknown>;
      },
      signal: controller.signal,
    },
  );

  await stream.result();
  const input = extractInput(payload);
  return {
    input,
    types: extractInputTypes(input),
  };
}

describe("openai-responses reasoning replay", () => {
  it("replays reasoning for tool-call-only turns (OpenAI requires it)", async () => {
    const assistantToolOnly = buildAssistantMessage({
      content: [
        buildReasoningPart(),
        {
          arguments: {},
          id: "call_123|fc_123",
          name: "noop",
          type: "toolCall",
        },
      ],
      stopReason: "toolUse",
    });

    const toolResult: ToolResultMessage = {
      content: [{ text: "ok", type: "text" }],
      isError: false,
      role: "toolResult",
      timestamp: Date.now(),
      toolCallId: "call_123|fc_123",
      toolName: "noop",
    };

    const { input, types } = await runAbortedOpenAIResponsesStream({
      messages: [
        {
          content: "Call noop.",
          role: "user",
          timestamp: Date.now(),
        },
        assistantToolOnly,
        toolResult,
        {
          content: "Now reply with ok.",
          role: "user",
          timestamp: Date.now(),
        },
      ],
      tools: [
        {
          description: "no-op",
          name: "noop",
          parameters: Type.Object({}, { additionalProperties: false }),
        },
      ],
    });

    expect(types).toContain("reasoning");
    expect(types).toContain("function_call");
    expect(types.indexOf("reasoning")).toBeLessThan(types.indexOf("function_call"));

    const functionCall = input.find(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "function_call",
    ) as Record<string, unknown> | undefined;
    expect(functionCall?.call_id).toBe("call_123");
    expect(functionCall?.id).toBe("fc_123");
  });

  it("still replays reasoning when paired with an assistant message", async () => {
    const assistantWithText = buildAssistantMessage({
      content: [buildReasoningPart(), { text: "hello", textSignature: "msg_test", type: "text" }],
      stopReason: "stop",
    });

    const { types } = await runAbortedOpenAIResponsesStream({
      messages: [
        { content: "Hi", role: "user", timestamp: Date.now() },
        assistantWithText,
        { content: "Ok", role: "user", timestamp: Date.now() },
      ],
    });

    expect(types).toContain("reasoning");
    expect(types).toContain("message");
  });

  it.each(["commentary", "final_answer"] as const)(
    "replays assistant message phase metadata for %s",
    async (phase) => {
      const assistantWithText = buildAssistantMessage({
        content: [
          buildReasoningPart(),
          {
            text: "hello",
            textSignature: JSON.stringify({ v: 1, id: `msg_${phase}`, phase }),
            type: "text",
          },
        ],
        stopReason: "stop",
      });

      const { input, types } = await runAbortedOpenAIResponsesStream({
        messages: [
          { content: "Hi", role: "user", timestamp: Date.now() },
          assistantWithText,
          { content: "Ok", role: "user", timestamp: Date.now() },
        ],
      });

      expect(types).toContain("message");

      const replayedMessage = extractInputMessages(input).find(
        (item) => item.id === `msg_${phase}`,
      );
      expect(replayedMessage?.phase).toBe(phase);
    },
  );
});
