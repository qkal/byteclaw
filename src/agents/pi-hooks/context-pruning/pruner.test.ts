import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { pruneContextMessages } from "./pruner.js";
import { DEFAULT_CONTEXT_PRUNING_SETTINGS } from "./settings.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantContentBlock = AssistantMessage["content"][number];

const CONTEXT_WINDOW_1M = {
  model: { contextWindow: 1_000_000 },
} as unknown as ExtensionContext;

function makeUser(text: string): AgentMessage {
  return {
    content: text,
    role: "user",
    timestamp: Date.now(),
  };
}

function makeAssistant(content: AssistantMessage["content"]): AgentMessage {
  return {
    api: "openai-responses",
    content,
    model: "test-model",
    provider: "openai",
    role: "assistant",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
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
    },
  };
}

function makeToolResult(
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[],
): AgentMessage {
  return {
    content,
    role: "toolResult",
    timestamp: Date.now(),
    toolName: "read",
  } as AgentMessage;
}

describe("pruneContextMessages", () => {
  it("does not crash on assistant message with malformed thinking block (missing thinking string)", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "thinking" } as unknown as AssistantContentBlock,
        { text: "ok", type: "text" },
      ]),
    ];
    expect(() =>
      pruneContextMessages({
        ctx: CONTEXT_WINDOW_1M,
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
      }),
    ).not.toThrow();
  });

  it("does not crash on assistant message with null content entries", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([null as unknown as AssistantContentBlock, { text: "world", type: "text" }]),
    ];
    expect(() =>
      pruneContextMessages({
        ctx: CONTEXT_WINDOW_1M,
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
      }),
    ).not.toThrow();
  });

  it("does not crash on assistant message with malformed text block (missing text string)", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "text" } as unknown as AssistantContentBlock,
        { thinking: "still fine", type: "thinking" },
      ]),
    ];
    expect(() =>
      pruneContextMessages({
        ctx: CONTEXT_WINDOW_1M,
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
      }),
    ).not.toThrow();
  });

  it("handles well-formed thinking blocks correctly", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { thinking: "let me think", type: "thinking" },
        { text: "here is the answer", type: "text" },
      ]),
    ];
    const result = pruneContextMessages({
      ctx: CONTEXT_WINDOW_1M,
      messages,
      settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
    });
    expect(result).toHaveLength(2);
  });

  it("counts thinkingSignature bytes when estimating assistant message size", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeToolResult([{ text: "X".repeat(2000), type: "text" }]),
      makeAssistant([
        {
          redacted: true,
          thinking: "[redacted]",
          thinkingSignature: "S".repeat(40_000),
          type: "thinking",
        } as unknown as AssistantContentBlock,
        { text: "done", type: "text" },
      ]),
    ];

    const result = pruneContextMessages({
      ctx: { model: { contextWindow: 5000 } } as unknown as ExtensionContext,
      isToolPrunable: () => true,
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        hardClear: { ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear, enabled: false },
        keepLastAssistants: 1,
        softTrim: { headChars: 100, maxChars: 200, tailChars: 50 },
        softTrimRatio: 0.5,
      },
    });

    const toolResult = result.find((message) => message.role === "toolResult") as Extract<
      AgentMessage,
      { role: "toolResult" }
    >;
    const textBlock = toolResult.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("[Tool result trimmed:");
  });

  it("counts redacted_thinking data bytes when estimating assistant message size", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeToolResult([{ text: "X".repeat(2000), type: "text" }]),
      makeAssistant([
        {
          data: "D".repeat(40_000),
          thinkingSignature: "sig",
          type: "redacted_thinking",
        } as unknown as AssistantContentBlock,
        { text: "done", type: "text" },
      ]),
    ];

    const result = pruneContextMessages({
      ctx: { model: { contextWindow: 5000 } } as unknown as ExtensionContext,
      isToolPrunable: () => true,
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        hardClear: { ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear, enabled: false },
        keepLastAssistants: 1,
        softTrim: { headChars: 100, maxChars: 200, tailChars: 50 },
        softTrimRatio: 0.5,
      },
    });

    const toolResult = result.find((message) => message.role === "toolResult") as Extract<
      AgentMessage,
      { role: "toolResult" }
    >;
    const textBlock = toolResult.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("[Tool result trimmed:");
  });

  it("ignores non-latest thinking signatures that will be dropped before send", () => {
    const messages: AgentMessage[] = [
      makeUser("first"),
      makeAssistant([
        {
          thinking: "internal",
          thinkingSignature: "S".repeat(40_000),
          type: "thinking",
        } as unknown as AssistantContentBlock,
        { text: "older reply", type: "text" },
      ]),
      makeToolResult([{ text: "X".repeat(2000), type: "text" }]),
      makeUser("latest"),
      makeAssistant([{ text: "latest reply", type: "text" }]),
    ];

    const result = pruneContextMessages({
      ctx: { model: { contextWindow: 5000 } } as unknown as ExtensionContext,
      dropThinkingBlocksForEstimate: true,
      isToolPrunable: () => true,
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        hardClear: { ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear, enabled: false },
        keepLastAssistants: 1,
        softTrim: { headChars: 100, maxChars: 200, tailChars: 50 },
        softTrimRatio: 0.5,
      },
    });

    expect(result).toBe(messages);
  });

  it("soft-trims image-containing tool results by replacing image blocks with placeholders", () => {
    const messages: AgentMessage[] = [
      makeUser("summarize this"),
      makeToolResult([
        { text: "A".repeat(120), type: "text" },
        { data: "img", mimeType: "image/png", type: "image" },
        { text: "B".repeat(120), type: "text" },
      ]),
      makeAssistant([{ text: "done", type: "text" }]),
    ];

    const result = pruneContextMessages({
      contextWindowTokensOverride: 16,
      ctx: CONTEXT_WINDOW_1M,
      isToolPrunable: () => true,
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        hardClear: {
          ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear,
          enabled: false,
        },
        keepLastAssistants: 1,
        softTrim: {
          headChars: 170,
          maxChars: 200,
          tailChars: 30,
        },
        softTrimRatio: 0,
      },
    });

    const toolResult = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0]).toMatchObject({ type: "text" });
    const textBlock = toolResult.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("[image removed during context pruning]");
    expect(textBlock.text).toContain(
      "[Tool result trimmed: kept first 170 chars and last 30 chars",
    );
  });

  it("replaces image-only tool results with placeholders even when text trimming is not needed", () => {
    const messages: AgentMessage[] = [
      makeUser("summarize this"),
      makeToolResult([{ data: "img", mimeType: "image/png", type: "image" }]),
      makeAssistant([{ text: "done", type: "text" }]),
    ];

    const result = pruneContextMessages({
      contextWindowTokensOverride: 1,
      ctx: CONTEXT_WINDOW_1M,
      isToolPrunable: () => true,
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        hardClear: {
          ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear,
          enabled: false,
        },
        hardClearRatio: 10,
        keepLastAssistants: 1,
        softTrim: {
          headChars: 2000,
          maxChars: 5000,
          tailChars: 2000,
        },
        softTrimRatio: 0,
      },
    });

    const toolResult = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.content).toEqual([
      { text: "[image removed during context pruning]", type: "text" },
    ]);
  });

  it("hard-clears image-containing tool results once ratios require clearing", () => {
    const messages: AgentMessage[] = [
      makeUser("summarize this"),
      makeToolResult([
        { text: "small text", type: "text" },
        { data: "img", mimeType: "image/png", type: "image" },
      ]),
      makeAssistant([{ text: "done", type: "text" }]),
    ];

    const placeholder = "[hard cleared test placeholder]";
    const result = pruneContextMessages({
      contextWindowTokensOverride: 8,
      ctx: CONTEXT_WINDOW_1M,
      isToolPrunable: () => true,
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        hardClear: {
          enabled: true,
          placeholder,
        },
        hardClearRatio: 0,
        keepLastAssistants: 1,
        minPrunableToolChars: 1,
        softTrim: {
          headChars: 2000,
          maxChars: 5000,
          tailChars: 2000,
        },
        softTrimRatio: 0,
      },
    });

    const toolResult = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.content).toEqual([{ text: placeholder, type: "text" }]);
  });
});
