import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { castAgentMessage, castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import {
  assessLastAssistantMessage,
  dropThinkingBlocks,
  isAssistantMessageWithContent,
  sanitizeThinkingForRecovery,
  wrapAnthropicStreamWithRecovery,
} from "./thinking.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function dropSingleAssistantContent(content: Record<string, unknown>[]) {
  const messages: AgentMessage[] = [
    castAgentMessage({
      content,
      role: "assistant",
    }),
  ];

  const result = dropThinkingBlocks(messages);
  return {
    assistant: result[0] as Extract<AgentMessage, { role: "assistant" }>,
    messages,
    result,
  };
}

describe("isAssistantMessageWithContent", () => {
  it("accepts assistant messages with array content and rejects others", () => {
    const assistant = castAgentMessage({
      content: [{ text: "ok", type: "text" }],
      role: "assistant",
    });
    const user = castAgentMessage({ content: "hi", role: "user" });
    const malformed = castAgentMessage({ content: "not-array", role: "assistant" });

    expect(isAssistantMessageWithContent(assistant)).toBe(true);
    expect(isAssistantMessageWithContent(user)).toBe(false);
    expect(isAssistantMessageWithContent(malformed)).toBe(false);
  });
});

describe("dropThinkingBlocks", () => {
  it("returns the original reference when no thinking blocks are present", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ content: "hello", role: "user" }),
      castAgentMessage({ content: [{ text: "world", type: "text" }], role: "assistant" }),
    ];

    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("preserves thinking blocks when the assistant message is the latest assistant turn", () => {
    const { assistant, messages, result } = dropSingleAssistantContent([
      { thinking: "internal", type: "thinking" },
      { text: "final", type: "text" },
    ]);
    expect(result).toBe(messages);
    expect(assistant.content).toEqual([
      { thinking: "internal", type: "thinking" },
      { text: "final", type: "text" },
    ]);
  });

  it("preserves a latest assistant turn even when all content blocks are thinking", () => {
    const { assistant } = dropSingleAssistantContent([
      { thinking: "internal-only", type: "thinking" },
    ]);
    expect(assistant.content).toEqual([{ thinking: "internal-only", type: "thinking" }]);
  });

  it("preserves thinking blocks in the latest assistant message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ content: "first", role: "user" }),
      castAgentMessage({
        content: [
          { thinking: "old", type: "thinking" },
          { text: "old text", type: "text" },
        ],
        role: "assistant",
      }),
      castAgentMessage({ content: "second", role: "user" }),
      castAgentMessage({
        content: [
          { thinking: "latest", thinkingSignature: "sig_latest", type: "thinking" },
          { text: "latest text", type: "text" },
        ],
        role: "assistant",
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const firstAssistant = result[1] as Extract<AgentMessage, { role: "assistant" }>;
    const latestAssistant = result[3] as Extract<AgentMessage, { role: "assistant" }>;

    expect(firstAssistant.content).toEqual([{ text: "old text", type: "text" }]);
    expect(latestAssistant.content).toEqual([
      { thinking: "latest", thinkingSignature: "sig_latest", type: "thinking" },
      { text: "latest text", type: "text" },
    ]);
  });
});

describe("sanitizeThinkingForRecovery", () => {
  it("drops the latest assistant message when the thinking block is unsigned", () => {
    const messages = castAgentMessages([
      { content: "hello", role: "user" },
      {
        content: [{ thinking: "partial", type: "thinking" }],
        role: "assistant",
      },
    ]);

    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual([messages[0]]);
    expect(result.prefill).toBe(false);
  });

  it("preserves later turns when dropping an incomplete assistant message", () => {
    const messages = castAgentMessages([
      { content: "hello", role: "user" },
      {
        content: [{ thinking: "partial", type: "thinking" }],
        role: "assistant",
      },
      { content: "follow up", role: "user" },
    ]);

    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual([messages[0], messages[2]]);
    expect(result.prefill).toBe(false);
  });

  it("marks signed thinking without text as a prefill recovery case", () => {
    const messages = castAgentMessages([
      { content: "hello", role: "user" },
      {
        content: [{ thinking: "complete", thinkingSignature: "sig", type: "thinking" }],
        role: "assistant",
      },
    ]);

    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toBe(messages);
    expect(result.prefill).toBe(true);
  });

  it("marks signed thinking with an empty text block as incomplete text", () => {
    const message = castAgentMessage({
      content: [
        { thinking: "complete", thinkingSignature: "sig", type: "thinking" },
        { text: "", type: "text" },
      ],
      role: "assistant",
    });

    expect(assessLastAssistantMessage(message)).toBe("incomplete-text");
  });

  it("treats partial text after signed thinking as valid", () => {
    const message = castAgentMessage({
      content: [
        { thinking: "complete", thinkingSignature: "sig", type: "thinking" },
        { text: "Here is my answ", type: "text" },
      ],
      role: "assistant",
    });

    expect(assessLastAssistantMessage(message)).toBe("valid");
  });

  it("treats non-string text blocks as incomplete text when thinking is signed", () => {
    const message = castAgentMessage({
      content: [
        { thinking: "complete", thinkingSignature: "sig", type: "thinking" },
        { text: { bad: true }, type: "text" },
      ],
      role: "assistant",
    });

    expect(assessLastAssistantMessage(message)).toBe("incomplete-text");
  });
});

describe("wrapAnthropicStreamWithRecovery", () => {
  const anthropicThinkingError = new Error(
    "thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
  );

  it("retries once when the request is rejected before streaming", async () => {
    let callCount = 0;
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return Promise.reject(anthropicThinkingError);
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    await expect(
      wrapped(
        {} as never,
        {
          messages: castAgentMessages([
            {
              content: [{ thinking: "secret", thinkingSignature: "sig", type: "thinking" }],
              role: "assistant",
            },
          ]),
        } as never,
        {} as never,
      ),
    ).rejects.toBe(anthropicThinkingError);
    expect(callCount).toBe(2);
  });

  it("does not retry when the stream fails after yielding a chunk", async () => {
    let callCount = 0;
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return (async function* failingStream() {
          yield "chunk";
          throw anthropicThinkingError;
        })();
      }) as unknown as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    const chunks: unknown[] = [];
    const response = wrapped({} as never, { messages: [] } as never, {} as never) as {
      result: () => Promise<unknown>;
    } & AsyncIterable<unknown>;
    for await (const chunk of response) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["chunk"]);
    await expect(response.result()).rejects.toBe(anthropicThinkingError);
    expect(callCount).toBe(1);
  });

  it("does not retry non-Anthropic-thinking errors", async () => {
    const rateLimitError = new Error("rate limit exceeded");
    let callCount = 0;
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return Promise.reject(rateLimitError);
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    await expect(wrapped({} as never, { messages: [] } as never, {} as never)).rejects.toBe(
      rateLimitError,
    );
    expect(callCount).toBe(1);
  });

  it("preserves result() for synchronous event streams", async () => {
    const finalMessage = castAgentMessage({
      api: "anthropic-messages",
      content: [{ text: "done", type: "text" }],
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      role: "assistant",
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
    }) as AssistantMessage;

    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ partial: finalMessage, type: "start" });
          stream.push({ message: finalMessage, reason: "stop", type: "done" });
          stream.end();
        });
        return stream;
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    const response = wrapped({} as never, { messages: [] } as never, {} as never) as {
      result: () => Promise<unknown>;
    } & AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const event of response) {
      events.push(event);
    }

    await expect(response.result()).resolves.toEqual(finalMessage);
    expect(events).toHaveLength(2);
  });
});
