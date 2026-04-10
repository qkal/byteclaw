import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  computeEffectiveSettings,
  default as contextPruningExtension,
  pruneContextMessages,
} from "./context-pruning.js";
import { getContextPruningRuntime, setContextPruningRuntime } from "./context-pruning/runtime.js";

function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
  return msg.role === "toolResult";
}

function toolText(msg: ToolResultMessage): string {
  const first = msg.content.find((b) => b.type === "text");
  if (!first || first.type !== "text") {
    return "";
  }
  return first.text;
}

function findToolResult(messages: AgentMessage[], toolCallId: string): ToolResultMessage {
  const msg = messages.find(
    (m): m is ToolResultMessage => isToolResultMessage(m) && m.toolCallId === toolCallId,
  );
  if (!msg) {
    throw new Error(`missing toolResult: ${toolCallId}`);
  }
  return msg;
}

function makeToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): ToolResultMessage {
  return {
    content: [{ text: params.text, type: "text" }],
    isError: false,
    role: "toolResult",
    timestamp: Date.now(),
    toolCallId: params.toolCallId,
    toolName: params.toolName,
  };
}

function makeImageToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): ToolResultMessage {
  const base = makeToolResult(params);
  return {
    ...base,
    content: [{ data: "AA==", mimeType: "image/png", type: "image" }, ...base.content],
  };
}

function makeAssistant(text: string): AgentMessage {
  return {
    api: "openai-responses",
    content: [{ text, type: "text" }],
    model: "fake",
    provider: "openai",
    role: "assistant",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 1,
      output: 1,
      totalTokens: 2,
    },
  };
}

function makeUser(text: string): AgentMessage {
  return { content: text, role: "user", timestamp: Date.now() };
}

type ContextPruningSettings = NonNullable<ReturnType<typeof computeEffectiveSettings>>;
type PruneArgs = Parameters<typeof pruneContextMessages>[0];
type PruneOverrides = Omit<PruneArgs, "messages" | "settings" | "ctx">;

const CONTEXT_WINDOW_1000 = {
  model: { contextWindow: 1000 },
} as unknown as ExtensionContext;

function makeAggressiveSettings(
  overrides: Partial<ContextPruningSettings> = {},
): ContextPruningSettings {
  return {
    ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
    hardClear: { enabled: true, placeholder: "[cleared]" },
    hardClearRatio: 0,
    keepLastAssistants: 0,
    minPrunableToolChars: 0,
    softTrim: { headChars: 3, maxChars: 10, tailChars: 3 },
    softTrimRatio: 0,
    ...overrides,
  };
}

function pruneWithAggressiveDefaults(
  messages: AgentMessage[],
  settingsOverrides: Partial<ContextPruningSettings> = {},
  extra: PruneOverrides = {},
): AgentMessage[] {
  return pruneContextMessages({
    ctx: CONTEXT_WINDOW_1000,
    messages,
    settings: makeAggressiveSettings(settingsOverrides),
    ...extra,
  });
}

function makeLargeExecToolResult(toolCallId: string, textChar: string): AgentMessage {
  return makeToolResult({
    text: textChar.repeat(20_000),
    toolCallId,
    toolName: "exec",
  });
}

function makeSimpleToolPruningMessages(includeTrailingAssistant = false): AgentMessage[] {
  return [
    makeUser("u1"),
    makeAssistant("a1"),
    makeLargeExecToolResult("t1", "x"),
    ...(includeTrailingAssistant ? [makeAssistant("a2")] : []),
  ];
}

type ContextHandler = (
  event: { messages: AgentMessage[] },
  ctx: ExtensionContext,
) => { messages: AgentMessage[] } | undefined;

function createContextHandler(): ContextHandler {
  let handler: ContextHandler | undefined;
  const api = {
    appendEntry: (_type: string, _data?: unknown) => {},
    on: (name: string, fn: unknown) => {
      if (name === "context") {
        handler = fn as ContextHandler;
      }
    },
  } as unknown as ExtensionAPI;

  contextPruningExtension(api);
  if (!handler) {
    throw new Error("missing context handler");
  }
  return handler;
}

function runContextHandler(
  handler: ContextHandler,
  messages: AgentMessage[],
  sessionManager: unknown,
) {
  return handler({ messages }, {
    model: undefined,
    sessionManager,
  } as unknown as ExtensionContext);
}

describe("context-pruning", () => {
  it("mode off disables pruning", () => {
    expect(computeEffectiveSettings({ mode: "off" })).toBeNull();
    expect(computeEffectiveSettings({})).toBeNull();
  });

  it("does not touch tool results after the last N assistants", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeToolResult({
        text: "x".repeat(20_000),
        toolCallId: "t1",
        toolName: "exec",
      }),
      makeUser("u2"),
      makeAssistant("a2"),
      makeToolResult({
        text: "y".repeat(20_000),
        toolCallId: "t2",
        toolName: "exec",
      }),
      makeUser("u3"),
      makeAssistant("a3"),
      makeToolResult({
        text: "z".repeat(20_000),
        toolCallId: "t3",
        toolName: "exec",
      }),
      makeUser("u4"),
      makeAssistant("a4"),
      makeToolResult({
        text: "w".repeat(20_000),
        toolCallId: "t4",
        toolName: "exec",
      }),
    ];

    const next = pruneWithAggressiveDefaults(messages, { keepLastAssistants: 3 });

    expect(toolText(findToolResult(next, "t2"))).toContain("y".repeat(20_000));
    expect(toolText(findToolResult(next, "t3"))).toContain("z".repeat(20_000));
    expect(toolText(findToolResult(next, "t4"))).toContain("w".repeat(20_000));
    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
  });

  it("never prunes tool results before the first user message", () => {
    const messages: AgentMessage[] = [
      makeAssistant("bootstrap tool calls"),
      makeToolResult({
        text: "x".repeat(20_000),
        toolCallId: "t0",
        toolName: "read",
      }),
      makeAssistant("greeting"),
      makeUser("u1"),
      makeToolResult({
        text: "y".repeat(20_000),
        toolCallId: "t1",
        toolName: "exec",
      }),
    ];

    const next = pruneWithAggressiveDefaults(
      messages,
      {},
      {
        contextWindowTokensOverride: 1000,
        isToolPrunable: () => true,
      },
    );

    expect(toolText(findToolResult(next, "t0"))).toBe("x".repeat(20_000));
    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
  });

  it("hard-clear removes eligible tool results before cutoff", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeLargeExecToolResult("t1", "x"),
      makeLargeExecToolResult("t2", "y"),
      makeUser("u2"),
      makeAssistant("a2"),
      makeLargeExecToolResult("t3", "z"),
    ];

    const next = pruneWithAggressiveDefaults(messages, {
      keepLastAssistants: 1,
      softTrim: DEFAULT_CONTEXT_PRUNING_SETTINGS.softTrim,
      softTrimRatio: 10,
    });

    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
    expect(toolText(findToolResult(next, "t2"))).toBe("[cleared]");
    // Tool results after the last assistant are protected.
    expect(toolText(findToolResult(next, "t3"))).toContain("z".repeat(20_000));
  });

  it("accounts for CJK Extension B text when deciding whether to prune", () => {
    const extensionBText = "𠀀".repeat(50);
    const messages: AgentMessage[] = [
      makeUser(extensionBText),
      makeToolResult({
        text: "keep me",
        toolCallId: "t1",
        toolName: "exec",
      }),
    ];

    const next = pruneContextMessages({
      contextWindowTokensOverride: 40,
      ctx: CONTEXT_WINDOW_1000,
      isToolPrunable: () => true,
      messages,
      settings: makeAggressiveSettings({
        hardClear: { enabled: true, placeholder: "[cleared]" },
        hardClearRatio: 1,
        keepLastAssistants: 0,
        minPrunableToolChars: 0,
        softTrimRatio: 1,
      }),
    });

    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
  });

  it("uses contextWindow override when ctx.model is missing", () => {
    const messages = makeSimpleToolPruningMessages(true);

    const next = pruneContextMessages({
      contextWindowTokensOverride: 1000,
      ctx: { model: undefined } as unknown as ExtensionContext,
      messages,
      settings: makeAggressiveSettings(),
    });

    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
  });

  it("reads per-session settings from registry", async () => {
    const sessionManager = {};

    setContextPruningRuntime(sessionManager, {
      contextWindowTokens: 1000,
      dropThinkingBlocks: false,
      isToolPrunable: () => true,
      lastCacheTouchAt: Date.now() - DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs - 1000,
      settings: makeAggressiveSettings(),
    });

    const messages = makeSimpleToolPruningMessages(true);

    const handler = createContextHandler();
    const result = runContextHandler(handler, messages, sessionManager);

    if (!result) {
      throw new Error("expected handler to return messages");
    }
    expect(toolText(findToolResult(result.messages, "t1"))).toBe("[cleared]");
  });

  it("cache-ttl prunes once and resets the ttl window", () => {
    const sessionManager = {};
    const lastTouch = Date.now() - DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs - 1000;

    setContextPruningRuntime(sessionManager, {
      contextWindowTokens: 1000,
      dropThinkingBlocks: false,
      isToolPrunable: () => true,
      lastCacheTouchAt: lastTouch,
      settings: makeAggressiveSettings(),
    });

    const messages = makeSimpleToolPruningMessages();

    const handler = createContextHandler();
    const first = runContextHandler(handler, messages, sessionManager);
    if (!first) {
      throw new Error("expected first prune");
    }
    expect(toolText(findToolResult(first.messages, "t1"))).toBe("[cleared]");

    const runtime = getContextPruningRuntime(sessionManager);
    if (!runtime?.lastCacheTouchAt) {
      throw new Error("expected lastCacheTouchAt");
    }
    expect(runtime.lastCacheTouchAt).toBeGreaterThan(lastTouch);

    const second = runContextHandler(handler, messages, sessionManager);
    expect(second).toBeUndefined();
  });

  it("respects tools allow/deny (deny wins; wildcards supported)", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeToolResult({
        text: "x".repeat(20_000),
        toolCallId: "t1",
        toolName: "Exec",
      }),
      makeToolResult({
        text: "y".repeat(20_000),
        toolCallId: "t2",
        toolName: "Browser",
      }),
    ];

    const next = pruneWithAggressiveDefaults(messages, {
      tools: { allow: ["ex*"], deny: ["exec"] },
    });

    // Deny wins => exec is not pruned, even though allow matches.
    expect(toolText(findToolResult(next, "t1"))).toContain("x".repeat(20_000));
    // Allow is non-empty and browser is not allowed => never pruned.
    expect(toolText(findToolResult(next, "t2"))).toContain("y".repeat(20_000));
  });

  it("replaces image blocks in tool results during soft trim", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeImageToolResult({
        text: "visible tool text",
        toolCallId: "t1",
        toolName: "exec",
      }),
    ];

    const next = pruneWithAggressiveDefaults(messages, {
      hardClear: { enabled: false, placeholder: "[cleared]" },
      hardClearRatio: 10,
      softTrim: { headChars: 100, maxChars: 200, tailChars: 100 },
    });

    const tool = findToolResult(next, "t1");
    expect(tool.content.some((b) => b.type === "image")).toBe(false);
    expect(toolText(tool)).toContain("[image removed during context pruning]");
    expect(toolText(tool)).toContain("visible tool text");
  });

  it("soft-trims across block boundaries", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      {
        content: [
          { text: "AAAAA", type: "text" },
          { text: "BBBBB", type: "text" },
        ],
        isError: false,
        role: "toolResult",
        timestamp: Date.now(),
        toolCallId: "t1",
        toolName: "exec",
      } as ToolResultMessage,
    ];

    const next = pruneWithAggressiveDefaults(messages, {
      hardClearRatio: 10,
      softTrim: { headChars: 7, maxChars: 5, tailChars: 3 },
    });

    const text = toolText(findToolResult(next, "t1"));
    expect(text).toContain("AAAAA\nB");
    expect(text).toContain("BBB");
    expect(text).toContain("[Tool result trimmed:");
  });

  it("soft-trims oversized tool results and preserves head/tail with a note", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeToolResult({
        text: "abcdefghij".repeat(1000),
        toolCallId: "t1",
        toolName: "exec",
      }),
    ];

    const next = pruneWithAggressiveDefaults(messages, {
      hardClearRatio: 10,
      softTrim: { headChars: 6, maxChars: 10, tailChars: 6 },
    });

    const tool = findToolResult(next, "t1");
    const text = toolText(tool);
    expect(text).toContain("abcdef");
    expect(text).toContain("efghij");
    expect(text).toContain("[Tool result trimmed:");
  });
});
