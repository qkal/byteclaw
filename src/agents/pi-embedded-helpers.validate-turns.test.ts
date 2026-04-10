import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  mergeConsecutiveUserTurns,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "./pi-embedded-helpers.js";

function asMessages(messages: unknown[]): AgentMessage[] {
  return messages as AgentMessage[];
}

function makeDualToolUseAssistantContent() {
  return [
    { arguments: {}, id: "tool-1", name: "test1", type: "toolUse" },
    { arguments: {}, id: "tool-2", name: "test2", type: "toolUse" },
    { text: "Done", type: "text" },
  ];
}

function makeDualToolAnthropicTurns(nextUserContent: unknown[]) {
  return asMessages([
    { content: [{ text: "Use tools", type: "text" }], role: "user" },
    {
      content: makeDualToolUseAssistantContent(),
      role: "assistant",
    },
    {
      content: nextUserContent,
      role: "user",
    },
  ]);
}

describe("validate turn edge cases", () => {
  it("returns empty array unchanged", () => {
    expect(validateGeminiTurns([])).toEqual([]);
    expect(validateAnthropicTurns([])).toEqual([]);
  });

  it("returns single message unchanged", () => {
    const geminiMsgs = asMessages([
      {
        content: "Hello",
        role: "user",
      },
    ]);
    const anthropicMsgs = asMessages([
      {
        content: [{ text: "Hello", type: "text" }],
        role: "user",
      },
    ]);
    expect(validateGeminiTurns(geminiMsgs)).toEqual(geminiMsgs);
    expect(validateAnthropicTurns(anthropicMsgs)).toEqual(anthropicMsgs);
  });
});

describe("validateGeminiTurns", () => {
  it("should leave alternating user/assistant unchanged", () => {
    const msgs = asMessages([
      { content: "Hello", role: "user" },
      { content: [{ text: "Hi", type: "text" }], role: "assistant" },
      { content: "How are you?", role: "user" },
      { content: [{ text: "Good!", type: "text" }], role: "assistant" },
    ]);
    const result = validateGeminiTurns(msgs);
    expect(result).toHaveLength(4);
    expect(result).toEqual(msgs);
  });

  it("should merge consecutive assistant messages", () => {
    const msgs = asMessages([
      { content: "Hello", role: "user" },
      {
        content: [{ text: "Part 1", type: "text" }],
        role: "assistant",
        stopReason: "end_turn",
      },
      {
        content: [{ text: "Part 2", type: "text" }],
        role: "assistant",
        stopReason: "end_turn",
      },
      { content: "How are you?", role: "user" },
    ]);

    const result = validateGeminiTurns(msgs);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ content: "Hello", role: "user" });
    expect(result[1].role).toBe("assistant");
    expect((result[1] as { content?: unknown[] }).content).toHaveLength(2);
    expect(result[2]).toEqual({ content: "How are you?", role: "user" });
  });

  it("should preserve metadata from later message when merging", () => {
    const msgs = asMessages([
      {
        content: [{ text: "Part 1", type: "text" }],
        role: "assistant",
        usage: { input: 10, output: 5 },
      },
      {
        content: [{ text: "Part 2", type: "text" }],
        role: "assistant",
        stopReason: "end_turn",
        usage: { input: 10, output: 10 },
      },
    ]);

    const result = validateGeminiTurns(msgs);

    expect(result).toHaveLength(1);
    const merged = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(merged.usage).toEqual({ input: 10, output: 10 });
    expect(merged.stopReason).toBe("end_turn");
    expect(merged.content).toHaveLength(2);
  });

  it("should handle toolResult messages without merging", () => {
    const msgs = asMessages([
      { content: "Use tool", role: "user" },
      {
        content: [{ id: "tool-1", input: {}, name: "test", type: "toolUse" }],
        role: "assistant",
      },
      {
        content: [{ text: "Found data", type: "text" }],
        role: "toolResult",
        toolUseId: "tool-1",
      },
      {
        content: [{ text: "Here's the answer", type: "text" }],
        role: "assistant",
      },
      {
        content: [{ text: "Extra thoughts", type: "text" }],
        role: "assistant",
      },
      { content: "Request 2", role: "user" },
    ]);

    const result = validateGeminiTurns(msgs);

    // Should merge the consecutive assistants
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("toolResult");
    expect(result[3].role).toBe("assistant");
    expect(result[4].role).toBe("user");
  });
});

describe("validateAnthropicTurns", () => {
  it("should return alternating user/assistant unchanged", () => {
    const msgs = asMessages([
      { content: [{ text: "Question", type: "text" }], role: "user" },
      {
        content: [{ text: "Answer", type: "text" }],
        role: "assistant",
      },
      { content: [{ text: "Follow-up", type: "text" }], role: "user" },
    ]);
    const result = validateAnthropicTurns(msgs);
    expect(result).toEqual(msgs);
  });

  it("should merge consecutive user messages", () => {
    const msgs = asMessages([
      {
        content: [{ text: "First message", type: "text" }],
        role: "user",
        timestamp: 1000,
      },
      {
        content: [{ text: "Second message", type: "text" }],
        role: "user",
        timestamp: 2000,
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    const {content} = (result[0] as { content: unknown[] });
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ text: "First message", type: "text" });
    expect(content[1]).toEqual({ text: "Second message", type: "text" });
    // Should take timestamp from the newer message
    expect((result[0] as { timestamp?: number }).timestamp).toBe(2000);
  });

  it("should merge three consecutive user messages", () => {
    const msgs = asMessages([
      { content: [{ text: "One", type: "text" }], role: "user" },
      { content: [{ text: "Two", type: "text" }], role: "user" },
      { content: [{ text: "Three", type: "text" }], role: "user" },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(1);
    const {content} = (result[0] as { content: unknown[] });
    expect(content).toHaveLength(3);
  });

  it("keeps newest metadata when merging consecutive users", () => {
    const msgs = asMessages([
      {
        attachments: [{ type: "image", url: "old.png" }],
        content: [{ text: "Old", type: "text" }],
        role: "user",
        timestamp: 1000,
      },
      {
        attachments: [{ type: "image", url: "new.png" }],
        content: [{ text: "New", type: "text" }],
        role: "user",
        someCustomField: "keep-me",
        timestamp: 2000,
      } as AgentMessage,
    ]);

    const result = validateAnthropicTurns(msgs) as Extract<AgentMessage, { role: "user" }>[];

    expect(result).toHaveLength(1);
    const merged = result[0];
    expect(merged.timestamp).toBe(2000);
    expect((merged as { attachments?: unknown[] }).attachments).toEqual([
      { type: "image", url: "new.png" },
    ]);
    expect((merged as { someCustomField?: string }).someCustomField).toBe("keep-me");
    expect(merged.content).toEqual([
      { text: "Old", type: "text" },
      { text: "New", type: "text" },
    ]);
  });

  it("merges consecutive users with images and preserves order", () => {
    const msgs = asMessages([
      {
        content: [
          { text: "first", type: "text" },
          { type: "image", url: "img1" },
        ],
        role: "user",
      },
      {
        content: [
          { type: "image", url: "img2" },
          { text: "second", type: "text" },
        ],
        role: "user",
      },
    ]);

    const [merged] = validateAnthropicTurns(msgs) as Extract<AgentMessage, { role: "user" }>[];
    expect(merged.content).toEqual([
      { text: "first", type: "text" },
      { type: "image", url: "img1" },
      { type: "image", url: "img2" },
      { text: "second", type: "text" },
    ]);
  });

  it("should not merge consecutive assistant messages", () => {
    const msgs = asMessages([
      { content: [{ text: "Question", type: "text" }], role: "user" },
      {
        content: [{ text: "Answer 1", type: "text" }],
        role: "assistant",
      },
      {
        content: [{ text: "Answer 2", type: "text" }],
        role: "assistant",
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    // ValidateAnthropicTurns only merges user messages, not assistant
    expect(result).toHaveLength(3);
  });

  it("should handle mixed scenario with steering messages", () => {
    // Simulates: user asks -> assistant errors -> steering user message injected
    const msgs = asMessages([
      { content: [{ text: "Original question", type: "text" }], role: "user" },
      {
        content: [],
        errorMessage: "Overloaded",
        role: "assistant",
        stopReason: "error",
      },
      {
        content: [{ text: "Steering: try again", type: "text" }],
        role: "user",
      },
      { content: [{ text: "Another follow-up", type: "text" }], role: "user" },
    ]);

    const result = validateAnthropicTurns(msgs);

    // The two consecutive user messages at the end should be merged
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user");
    const lastContent = (result[2] as { content: unknown[] }).content;
    expect(lastContent).toHaveLength(2);
  });
});

describe("mergeConsecutiveUserTurns", () => {
  it("keeps newest metadata while merging content", () => {
    const previous = {
      attachments: [{ type: "image", url: "old.png" }],
      content: [{ text: "before", type: "text" }],
      role: "user",
      timestamp: 1000,
    } as Extract<AgentMessage, { role: "user" }>;
    const current = {
      attachments: [{ type: "image", url: "new.png" }],
      content: [{ text: "after", type: "text" }],
      role: "user",
      someCustomField: "keep-me",
      timestamp: 2000,
    } as Extract<AgentMessage, { role: "user" }>;

    const merged = mergeConsecutiveUserTurns(previous, current);

    expect(merged.content).toEqual([
      { text: "before", type: "text" },
      { text: "after", type: "text" },
    ]);
    expect((merged as { attachments?: unknown[] }).attachments).toEqual([
      { type: "image", url: "new.png" },
    ]);
    expect((merged as { someCustomField?: string }).someCustomField).toBe("keep-me");
    expect(merged.timestamp).toBe(2000);
  });

  it("backfills timestamp from earlier message when missing", () => {
    const previous = {
      content: [{ text: "before", type: "text" }],
      role: "user",
      timestamp: 1000,
    } as Extract<AgentMessage, { role: "user" }>;
    const current = {
      content: [{ text: "after", type: "text" }],
      role: "user",
    } as Extract<AgentMessage, { role: "user" }>;

    const merged = mergeConsecutiveUserTurns(previous, current);

    expect(merged.timestamp).toBe(1000);
  });
});

describe("validateAnthropicTurns strips dangling tool_use blocks", () => {
  it("should strip tool_use blocks without matching tool_result", () => {
    // Simulates: user asks -> assistant has tool_use -> user responds without tool_result
    // This happens after compaction trims history
    const msgs = asMessages([
      { content: [{ text: "Use tool", type: "text" }], role: "user" },
      {
        content: [
          { arguments: {}, id: "tool-1", name: "test", type: "toolUse" },
          { text: "I'll check that", type: "text" },
        ],
        role: "assistant",
      },
      { content: [{ text: "Hello", type: "text" }], role: "user" },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // The dangling tool_use should be stripped, but text content preserved
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([{ text: "I'll check that", type: "text" }]);
  });

  it("should preserve tool_use blocks with matching tool_result", () => {
    const msgs = asMessages([
      { content: [{ text: "Use tool", type: "text" }], role: "user" },
      {
        content: [
          { arguments: {}, id: "tool-1", name: "test", type: "toolUse" },
          { text: "Here's result", type: "text" },
        ],
        role: "assistant",
      },
      {
        content: [
          { content: [{ type: "text", text: "Result" }], toolUseId: "tool-1", type: "toolResult" },
          { text: "Thanks", type: "text" },
        ],
        role: "user",
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // Tool_use should be preserved because matching tool_result exists
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { arguments: {}, id: "tool-1", name: "test", type: "toolUse" },
      { text: "Here's result", type: "text" },
    ]);
  });

  it("should insert fallback text when all content would be removed", () => {
    const msgs = asMessages([
      { content: [{ text: "Use tool", type: "text" }], role: "user" },
      {
        content: [{ arguments: {}, id: "tool-1", name: "test", type: "toolUse" }],
        role: "assistant",
      },
      { content: [{ text: "Hello", type: "text" }], role: "user" },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // Should insert fallback text since all content would be removed
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([{ text: "[tool calls omitted]", type: "text" }]);
  });

  it("leaves aborted tool-only assistant turns empty instead of synthesizing fallback text", () => {
    const msgs = asMessages([
      { content: [{ text: "Use tool", type: "text" }], role: "user" },
      {
        content: [{ arguments: {}, id: "tool-1", name: "test", type: "toolCall" }],
        role: "assistant",
        stopReason: "aborted",
      },
      { content: [{ text: "Hello", type: "text" }], role: "user" },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    expect((result[1] as { content?: unknown[] }).content).toEqual([]);
  });

  it("should handle multiple dangling tool_use blocks", () => {
    const msgs = makeDualToolAnthropicTurns([{ text: "OK", type: "text" }]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    // Only text content should remain
    expect(assistantContent).toEqual([{ text: "Done", type: "text" }]);
  });

  it("should handle mixed tool_use with some having matching tool_result", () => {
    const msgs = makeDualToolAnthropicTurns([
      {
        content: [{ text: "Result 1", type: "text" }],
        toolUseId: "tool-1",
        type: "toolResult",
      },
      { text: "Thanks", type: "text" },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // Tool-1 should be preserved (has matching tool_result), tool-2 stripped, text preserved
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { arguments: {}, id: "tool-1", name: "test1", type: "toolUse" },
      { text: "Done", type: "text" },
    ]);
  });

  it("matches standalone toolResult messages before the next assistant turn", () => {
    const msgs = asMessages([
      { content: [{ text: "Use tool", type: "text" }], role: "user" },
      {
        content: [{ arguments: {}, id: "tool-1", name: "test", type: "toolCall" }],
        role: "assistant",
      },
      { content: [{ text: "data", type: "text" }], role: "toolResult", toolCallId: "tool-1" },
      { content: [{ text: "Continue", type: "text" }], role: "user" },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(4);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { arguments: {}, id: "tool-1", name: "test", type: "toolCall" },
    ]);
  });

  it("matches tool result blocks across intermediate non-assistant messages", () => {
    const msgs = asMessages([
      { content: [{ text: "Use tool", type: "text" }], role: "user" },
      {
        content: [
          { arguments: {}, id: "tool-1", name: "test", type: "functionCall" },
          { text: "Checking", type: "text" },
        ],
        role: "assistant",
      },
      { content: [{ text: "still waiting", type: "text" }], role: "user" },
      { content: [{ text: "data", type: "text" }], role: "tool", toolCallId: "tool-1" },
      { content: [{ text: "Continue", type: "text" }], role: "user" },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(5);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { arguments: {}, id: "tool-1", name: "test", type: "functionCall" },
      { text: "Checking", type: "text" },
    ]);
  });

  it("is replay-safe across repeated validation passes", () => {
    const msgs = makeDualToolAnthropicTurns([
      {
        content: [{ text: "Result 1", type: "text" }],
        toolUseId: "tool-1",
        type: "toolResult",
      },
    ]);

    const firstPass = validateAnthropicTurns(msgs);
    const secondPass = validateAnthropicTurns(firstPass);

    expect(secondPass).toEqual(firstPass);
  });

  it("does not crash when assistant content is non-array", () => {
    const msgs = [
      { content: [{ text: "Use tool", type: "text" }], role: "user" },
      {
        content: "legacy-content",
        role: "assistant",
      },
      { content: [{ text: "Thanks", type: "text" }], role: "user" },
    ] as unknown as AgentMessage[];

    expect(() => validateAnthropicTurns(msgs)).not.toThrow();
    const result = validateAnthropicTurns(msgs);
    expect(result).toHaveLength(3);
  });
});
