import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { limitHistoryTurns } from "./pi-embedded-runner.js";

describe("limitHistoryTurns", () => {
  const mockUsage = {
    cacheRead: 0,
    cacheWrite: 0,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      total: 0,
    },
    input: 1,
    output: 1,
    totalTokens: 2,
  } as const;

  const userMessage = (text: string): AgentMessage =>
    ({
      content: [{ text, type: "text" }],
      role: "user",
      timestamp: Date.now(),
    }) as AgentMessage;

  const assistantTextMessage = (text: string): AgentMessage =>
    ({
      api: "openai-responses",
      content: [{ text, type: "text" }],
      model: "mock-1",
      provider: "openai",
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: mockUsage,
    }) as AgentMessage;

  const assistantToolCallMessage = (id: string): AgentMessage =>
    ({
      api: "openai-responses",
      content: [{ arguments: {}, id, name: "exec", type: "toolCall" }],
      model: "mock-1",
      provider: "openai",
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: mockUsage,
    }) as AgentMessage;

  const firstText = (message: AgentMessage): string | undefined => {
    if (!("content" in message)) {
      return undefined;
    }
    const { content } = message;
    if (typeof content === "string") {
      return content;
    }
    const first = content[0];
    return first?.type === "text" ? first.text : undefined;
  };

  const makeMessages = (roles: ("user" | "assistant")[]): AgentMessage[] =>
    roles.map((role, i) =>
      role === "user" ? userMessage(`message ${i}`) : assistantTextMessage(`message ${i}`),
    );

  it("returns all messages when limit is undefined", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, undefined)).toBe(messages);
  });

  it("returns all messages when limit is 0", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 0)).toBe(messages);
  });

  it("returns all messages when limit is negative", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, -1)).toBe(messages);
  });

  it("returns empty array when messages is empty", () => {
    expect(limitHistoryTurns([], 5)).toEqual([]);
  });

  it("keeps all messages when fewer user turns than limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 10)).toBe(messages);
  });

  it("limits to last N user turns", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 2);
    expect(limited.length).toBe(4);
    expect(firstText(limited[0])).toBe("message 2");
  });

  it("handles single user turn limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(firstText(limited[0])).toBe("message 4");
    expect(firstText(limited[1])).toBe("message 5");
  });

  it("handles messages with multiple assistant responses per user turn", () => {
    const messages = makeMessages(["user", "assistant", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(limited[0].role).toBe("user");
    expect(limited[1].role).toBe("assistant");
  });

  it("preserves message content integrity", () => {
    const messages: AgentMessage[] = [
      userMessage("first"),
      assistantToolCallMessage("1"),
      userMessage("second"),
      assistantTextMessage("response"),
    ];
    const limited = limitHistoryTurns(messages, 1);
    expect(firstText(limited[0])).toBe("second");
    expect(firstText(limited[1])).toBe("response");
  });
});
