import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
} from "./pi-embedded-helpers.js";
import {
  castAgentMessages,
  makeAgentAssistantMessage,
} from "./test-helpers/agent-message-fixtures.js";

let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

function makeToolCallResultPairInput(): (AssistantMessage | ToolResultMessage)[] {
  return [
    makeAgentAssistantMessage({
      content: [
        {
          arguments: { path: "package.json" },
          id: "call_123|fc_456",
          name: "read",
          type: "toolCall",
        },
      ],
      model: "gpt-5.4",
      stopReason: "toolUse",
      timestamp: nextTimestamp(),
    }),
    {
      content: [{ text: "ok", type: "text" }],
      isError: false,
      role: "toolResult",
      timestamp: nextTimestamp(),
      toolCallId: "call_123|fc_456",
      toolName: "read",
    },
  ];
}

function makeEmptyAssistantErrorMessage(): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [],
    model: "gpt-5.4",
    stopReason: "error",
    timestamp: nextTimestamp(),
  }) satisfies AssistantMessage;
}

function makeOpenAiResponsesAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
  return makeAgentAssistantMessage({
    content,
    model: "gpt-5.4",
    stopReason,
    timestamp: nextTimestamp(),
  });
}

function expectToolCallAndResultIds(out: AgentMessage[], expectedId: string) {
  const assistant = out[0];
  expect(assistant.role).toBe("assistant");
  const assistantContent = assistant.role === "assistant" ? assistant.content : [];
  const toolCall = assistantContent.find((block) => block.type === "toolCall");
  expect(toolCall?.id).toBe(expectedId);

  const toolResult = out[1];
  expect(toolResult.role).toBe("toolResult");
  if (toolResult.role === "toolResult") {
    expect(toolResult.toolCallId).toBe(expectedId);
  }
}

function expectSingleAssistantContentEntry(
  out: AgentMessage[],
  expectEntry: (entry: { type?: string; text?: string }) => void,
) {
  expect(out).toHaveLength(1);
  expect(out[0]?.role).toBe("assistant");
  const content = out[0]?.role === "assistant" ? out[0].content : [];
  expect(content).toHaveLength(1);
  expectEntry((content as { type?: string; text?: string }[])[0] ?? {});
}

describe("sanitizeSessionMessagesImages", () => {
  it("keeps tool call + tool result IDs unchanged by default", async () => {
    const input = makeToolCallResultPairInput();

    const out = await sanitizeSessionMessagesImages(input, "test");

    expectToolCallAndResultIds(out, "call_123|fc_456");
  });

  it("sanitizes tool call + tool result IDs in strict mode (alphanumeric only)", async () => {
    const input = makeToolCallResultPairInput();

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    // Strict mode strips all non-alphanumeric characters
    expectToolCallAndResultIds(out, "call123fc456");
  });

  it("does not synthesize tool call input when missing", async () => {
    const input = castAgentMessages([
      makeOpenAiResponsesAssistantMessage([
        { arguments: {}, id: "call_1", name: "read", type: "toolCall" },
      ]),
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");
    const assistant = out[0] as { content?: Record<string, unknown>[] };
    const toolCall = assistant.content?.find((b) => b.type === "toolCall");
    expect(toolCall).toBeTruthy();
    expect("input" in (toolCall ?? {})).toBe(false);
  });

  it("removes empty assistant text blocks but preserves tool calls", async () => {
    const input = castAgentMessages([
      makeOpenAiResponsesAssistantMessage([
        { text: "", type: "text" },
        { arguments: {}, id: "call_1", name: "read", type: "toolCall" },
      ]),
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expectSingleAssistantContentEntry(out, (entry) => {
      expect(entry.type).toBe("toolCall");
    });
  });

  it("sanitizes tool ids in strict mode (alphanumeric only)", async () => {
    const input = castAgentMessages([
      {
        content: [
          { id: "call_abc|item:123", input: {}, name: "test", type: "toolUse" },
          {
            arguments: {},
            id: "call_abc|item:456",
            name: "exec",
            type: "toolCall",
          },
        ],
        role: "assistant",
      },
      {
        content: [{ text: "ok", type: "text" }],
        role: "toolResult",
        toolUseId: "call_abc|item:123",
      },
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    // Strict mode strips all non-alphanumeric characters
    const assistant = out[0] as { content?: { id?: string }[] };
    expect(assistant.content?.[0]?.id).toBe("callabcitem123");
    expect(assistant.content?.[1]?.id).toBe("callabcitem456");

    const toolResult = out[1] as { toolUseId?: string };
    expect(toolResult.toolUseId).toBe("callabcitem123");
  });

  it("sanitizes tool IDs in images-only mode when explicitly enabled", async () => {
    const input = makeToolCallResultPairInput();

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeMode: "images-only",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    const assistant = out[0];
    const toolCall =
      assistant?.role === "assistant"
        ? assistant.content.find((b) => b.type === "toolCall")
        : undefined;
    expect(toolCall?.id).toBe("call123fc456");

    const toolResult = out[1];
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.toolCallId).toBe("call123fc456");
    }
  });
  it("filters whitespace-only assistant text blocks", async () => {
    const input = castAgentMessages([
      {
        api: "openai-responses",
        content: [
          { text: "   ", type: "text" },
          { text: "ok", type: "text" },
        ],
        model: "gpt-5.4",
        provider: "openai",
        role: "assistant",
        stopReason: "stop",
        timestamp: nextTimestamp(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      },
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expectSingleAssistantContentEntry(out, (entry) => {
      expect(entry.text).toBe("ok");
    });
  });
  it("drops assistant messages that only contain empty text", async () => {
    const input = castAgentMessages([
      { content: "hello", role: "user", timestamp: nextTimestamp() } satisfies UserMessage,
      {
        api: "openai-responses",
        content: [{ text: "", type: "text" }],
        model: "gpt-5.4",
        provider: "openai",
        role: "assistant",
        stopReason: "stop",
        timestamp: nextTimestamp(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      } satisfies AssistantMessage,
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });
  it("keeps empty assistant error messages", async () => {
    const input = castAgentMessages([
      { content: "hello", role: "user", timestamp: nextTimestamp() } satisfies UserMessage,
      {
        ...makeEmptyAssistantErrorMessage(),
      },
      {
        ...makeEmptyAssistantErrorMessage(),
      },
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
    expect(out[2]?.role).toBe("assistant");
  });
  it("leaves non-assistant messages unchanged", async () => {
    const input = [
      { content: "hello", role: "user", timestamp: nextTimestamp() } satisfies UserMessage,
      {
        content: [{ text: "result", type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: nextTimestamp(),
        toolCallId: "tool-1",
        toolName: "read",
      } satisfies ToolResultMessage,
    ];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("toolResult");
  });

  describe("thought_signature stripping", () => {
    it("strips msg_-prefixed thought_signature from assistant message content blocks", async () => {
      const input = castAgentMessages([
        {
          content: [
            { text: "hello", thought_signature: "msg_abc123", type: "text" },
            {
              thinking: "reasoning",
              thought_signature: "AQID",
              type: "thinking",
            },
          ],
          role: "assistant",
        },
      ]);

      const out = await sanitizeSessionMessagesImages(input, "test");

      expect(out).toHaveLength(1);
      const {content} = (out[0] as { content?: unknown[] });
      expect(content).toHaveLength(2);
      expect("thought_signature" in ((content?.[0] ?? {}) as object)).toBe(false);
      expect((content?.[1] as { thought_signature?: unknown })?.thought_signature).toBe("AQID");
    });

    it("still strips signatures in images-only mode when replay policy requests it", async () => {
      const input = castAgentMessages([
        {
          content: [
            { thinking: "internal", thought_signature: "msg_abc123", type: "thinking" },
            { text: "visible", type: "text" },
          ],
          role: "assistant",
        },
      ]);

      const out = await sanitizeSessionMessagesImages(input, "test", {
        sanitizeMode: "images-only",
        sanitizeThoughtSignatures: {
          allowBase64Only: true,
          includeCamelCase: true,
        },
      });

      const {content} = (out[0] as { content?: { thought_signature?: unknown }[] });
      expect(content).toHaveLength(2);
      expect(content?.[0]?.thought_signature).toBeUndefined();
    });

    it("preserves interleaved thinking block order when signatures are preserved", async () => {
      const input = castAgentMessages([
        {
          content: [
            {
              thinking: "first",
              thought_signature: "sig-1",
              type: "thinking",
            },
            { text: "", type: "text" },
            { text: "visible", type: "text" },
            {
              data: "opaque",
              thought_signature: "sig-2",
              type: "redacted_thinking",
            },
            { text: "tail", type: "text" },
          ],
          role: "assistant",
        },
      ]);

      const out = await sanitizeSessionMessagesImages(input, "test", {
        preserveSignatures: true,
      });

      expect(out).toHaveLength(1);
      const {content} = (out[0] as { content?: { type?: string; text?: string }[] });
      expect(content?.map((block) => block.type)).toEqual([
        "thinking",
        "text",
        "text",
        "redacted_thinking",
        "text",
      ]);
      expect(content?.[0]).toMatchObject({
        thinking: "first",
        thought_signature: "sig-1",
        type: "thinking",
      });
      expect(content?.[1]).toMatchObject({ text: "", type: "text" });
      expect(content?.[3]).toMatchObject({
        thought_signature: "sig-2",
        type: "redacted_thinking",
      });
    });
  });
});

describe("sanitizeGoogleTurnOrdering", () => {
  it("prepends a synthetic user turn when history starts with assistant", () => {
    const input = castAgentMessages([
      {
        content: [{ arguments: {}, id: "call_1", name: "exec", type: "toolCall" }],
        role: "assistant",
      },
    ]);

    const out = sanitizeGoogleTurnOrdering(input);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
  });
  it("is a no-op when history starts with user", () => {
    const input = castAgentMessages([{ content: "hi", role: "user" }]);
    const out = sanitizeGoogleTurnOrdering(input);
    expect(out).toBe(input);
  });
});
