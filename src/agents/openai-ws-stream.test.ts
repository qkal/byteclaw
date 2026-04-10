/**
 * Unit tests for openai-ws-stream.ts
 *
 * Covers:
 *  - Message format converters (convertMessagesToInputItems, convertTools)
 *  - Response → AssistantMessage parser (buildAssistantMessageFromResponse)
 *  - createOpenAIWebSocketStreamFn behaviour (connect, send, receive, fallback)
 *  - Session registry helpers (releaseWsSession, hasWsSession)
 */

import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponseObject } from "./openai-ws-connection.js";
import { buildOpenAIWebSocketResponseCreatePayload } from "./openai-ws-request.js";
import {
  buildAssistantMessageFromResponse,
  convertMessagesToInputItems,
  convertTools,
  createOpenAIWebSocketStreamFn,
  hasWsSession,
  __testing as openAIWsStreamTesting,
  planTurnInput,
  releaseWsSession,
} from "./openai-ws-stream.js";
import { log } from "./pi-embedded-runner/logger.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock OpenAIWebSocketManager
// ─────────────────────────────────────────────────────────────────────────────

// We mock the entire openai-ws-connection module so no real WebSocket is opened.
const { MockManager } = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  type AnyFn = (...args: unknown[]) => void;

  // Shared mutable flag so inner class can see it
  let _globalConnectShouldFail = false;
  let _globalSendFailuresRemaining = 0;

  class MockManager extends EventEmitter {
    private _listeners: AnyFn[] = [];
    private _previousResponseId: string | null = null;
    private _connected = false;
    private _broken = false;
    private _lastCloseInfo: { code: number; reason: string; retryable: boolean } | null = null;

    sentEvents: unknown[] = [];
    connectCallCount = 0;
    closeCallCount = 0;
    options: unknown;

    // Allow tests to override connect/send behaviour
    connectShouldFail = false;
    sendShouldFail = false;

    constructor(options?: unknown) {
      super();
      this.options = options;
    }

    get previousResponseId(): string | null {
      return this._previousResponseId;
    }

    get lastCloseInfo(): { code: number; reason: string; retryable: boolean } | null {
      return this._lastCloseInfo;
    }

    async connect(_apiKey: string): Promise<void> {
      this.connectCallCount++;
      if (this.connectShouldFail || _globalConnectShouldFail) {
        throw new Error("Mock connect failure");
      }
      this._connected = true;
    }

    isConnected(): boolean {
      return this._connected && !this._broken;
    }

    send(event: unknown): void {
      if (!this._connected) {
        throw new Error("cannot send — not connected");
      }
      if (this.sendShouldFail || _globalSendFailuresRemaining > 0) {
        if (_globalSendFailuresRemaining > 0) {
          _globalSendFailuresRemaining--;
        }
        throw new Error("Mock send failure");
      }
      this.sentEvents.push(event);
      const maybeEvent = event as { type?: string; generate?: boolean; model?: string } | null;
      // Auto-complete warm-up events so warm-up-enabled tests don't hang waiting
      // For the warm-up terminal event.
      if (maybeEvent?.type === "response.create" && maybeEvent.generate === false) {
        queueMicrotask(() => {
          this.simulateEvent({
            response: makeResponseObject(`warmup-${Date.now()}`),
            type: "response.completed",
          });
        });
      }
    }

    warmUp(params: { model: string; tools?: unknown[]; instructions?: string }): void {
      this.send({
        generate: false,
        model: params.model,
        type: "response.create",
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.instructions ? { instructions: params.instructions } : {}),
      });
    }

    onMessage(handler: (event: unknown) => void): () => void {
      this._listeners.push(handler as AnyFn);
      return () => {
        this._listeners = this._listeners.filter((l) => l !== handler);
      };
    }

    close(): void {
      this.closeCallCount++;
      this._connected = false;
      this._lastCloseInfo = {
        code: 1000,
        reason: "closed",
        retryable: false,
      };
      this.emit("close", 1000, "closed");
    }

    // Test helper: simulate WebSocket connection drop mid-request
    simulateClose(code = 1006, reason = "connection lost"): void {
      this._connected = false;
      this._lastCloseInfo = {
        code,
        reason,
        retryable:
          code === 1001 ||
          code === 1005 ||
          code === 1006 ||
          code === 1011 ||
          code === 1012 ||
          code === 1013,
      };
      this.emit("close", code, reason);
    }

    // Test helper: simulate a server event
    simulateEvent(event: unknown): void {
      for (const fn of this._listeners) {
        fn(event);
      }
    }

    // Test helper: simulate connection being broken
    simulateBroken(): void {
      this._connected = false;
      this._broken = true;
    }

    // Test helper: set the previous response ID as if a turn completed
    setPreviousResponseId(id: string): void {
      this._previousResponseId = id;
    }

    static lastInstance: MockManager | null = null;
    static instances: MockManager[] = [];

    static reset(): void {
      MockManager.lastInstance = null;
      MockManager.instances = [];
    }
  }

  // Patch constructor to track instances
  const OriginalMockManager = MockManager;
  class TrackedMockManager extends OriginalMockManager {
    constructor(...args: ConstructorParameters<typeof OriginalMockManager>) {
      super(...args);
      TrackedMockManager.lastInstance = this;
      TrackedMockManager.instances.push(this);
    }

    static lastInstance: TrackedMockManager | null = null;
    static instances: TrackedMockManager[] = [];

    /** Class-level flag: make ALL new instances fail on connect(). */
    static get globalConnectShouldFail(): boolean {
      return _globalConnectShouldFail;
    }
    static set globalConnectShouldFail(v: boolean) {
      _globalConnectShouldFail = v;
    }

    static get globalSendFailuresRemaining(): number {
      return _globalSendFailuresRemaining;
    }
    static set globalSendFailuresRemaining(v: number) {
      _globalSendFailuresRemaining = v;
    }

    static reset(): void {
      TrackedMockManager.lastInstance = null;
      TrackedMockManager.instances = [];
      _globalConnectShouldFail = false;
      _globalSendFailuresRemaining = 0;
    }
  }

  return { MockManager: TrackedMockManager };
});

// Track if streamSimple (HTTP fallback) was called
const streamSimpleCalls: { model: unknown; context: unknown; options?: unknown }[] = [];
const mockStreamSimple = vi.fn((model: unknown, context: unknown, options?: unknown) => {
  streamSimpleCalls.push({ context, model, options });
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const msg = makeFakeAssistantMessage("http fallback response");
    stream.push({ message: msg, reason: "stop", type: "done" });
    stream.end();
  });
  return stream;
});
const mockCreateHttpFallbackStreamFn = vi.fn(() => mockStreamSimple as never);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a StreamFn return value (which may be a Promise) to an AsyncIterable. */
async function resolveStream(
  stream: ReturnType<ReturnType<typeof createOpenAIWebSocketStreamFn>>,
): Promise<AsyncIterable<unknown>> {
  return stream instanceof Promise ? await stream : stream;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

type FakeMessage =
  | { role: "user"; content: string | unknown[]; timestamp: number }
  | {
      role: "assistant";
      content: unknown[];
      phase?: "commentary" | "final_answer";
      stopReason: string;
      api: string;
      provider: string;
      model: string;
      usage: unknown;
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: unknown[];
      isError: boolean;
      timestamp: number;
    };

function userMsg(text: string): FakeMessage {
  return { content: text, role: "user", timestamp: 0 };
}

function assistantMsg(
  textBlocks: string[],
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [],
  phase?: "commentary" | "final_answer",
): FakeMessage {
  const content: unknown[] = [];
  for (const t of textBlocks) {
    content.push({ text: t, type: "text" });
  }
  for (const tc of toolCalls) {
    content.push({ arguments: tc.args, id: tc.id, name: tc.name, type: "toolCall" });
  }
  return {
    api: "openai-responses",
    content,
    model: "gpt-5.4",
    phase,
    provider: "openai",
    role: "assistant",
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: 0,
    usage: {},
  };
}

function toolResultMsg(callId: string, output: string): FakeMessage {
  return {
    content: [{ text: output, type: "text" }],
    isError: false,
    role: "toolResult",
    timestamp: 0,
    toolCallId: callId,
    toolName: "test_tool",
  };
}

function makeFakeAssistantMessage(text: string) {
  return {
    api: "openai-responses",
    content: [{ text, type: "text" as const }],
    model: "gpt-5.4",
    provider: "openai",
    role: "assistant" as const,
    stopReason: "stop" as const,
    timestamp: Date.now(),
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 10,
      output: 5,
      totalTokens: 15,
    },
  };
}

function makeResponseObject(
  id: string,
  outputText?: string,
  toolCallName?: string,
  phase?: "commentary" | "final_answer",
): ResponseObject {
  const output: ResponseObject["output"] = [];
  if (outputText) {
    output.push({
      content: [{ text: outputText, type: "output_text" }],
      id: "item_1",
      phase,
      role: "assistant",
      type: "message",
    });
  }
  if (toolCallName) {
    output.push({
      arguments: '{"arg":"value"}',
      call_id: "call_abc",
      id: "item_2",
      name: toolCallName,
      type: "function_call",
    });
  }
  return {
    created_at: Date.now(),
    id,
    model: "gpt-5.4",
    object: "response",
    output,
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("convertTools", () => {
  it("returns empty array for undefined tools", () => {
    expect(convertTools(undefined)).toEqual([]);
  });

  it("returns empty array for empty tools", () => {
    expect(convertTools([])).toEqual([]);
  });

  it("converts tools to FunctionToolDefinition format", () => {
    const tools = [
      {
        description: "Run a command",
        name: "exec",
        parameters: { properties: { cmd: { type: "string" } }, type: "object" },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      description: "Run a command",
      name: "exec",
      parameters: { properties: { cmd: { type: "string" } }, type: "object" },
      type: "function",
    });
  });

  it("handles tools without description", () => {
    const tools = [{ description: "", name: "ping", parameters: {} }];
    const result = convertTools(tools as Parameters<typeof convertTools>[0]);
    expect(result[0]?.name).toBe("ping");
  });

  it("normalizes truly empty parameter schemas for parameter-free tools", () => {
    const tools = [{ description: "No params", name: "ping", parameters: {} }];
    const result = convertTools(tools as Parameters<typeof convertTools>[0]);
    expect(result[0]?.parameters).toEqual({
      properties: {},
      type: "object",
    });
  });

  it("injects properties:{} for type:object schemas missing properties (MCP no-param tools)", () => {
    const tools = [
      { description: "List AWS regions", name: "list_regions", parameters: { type: "object" } },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      description: "List AWS regions",
      name: "list_regions",
      parameters: { properties: {}, type: "object" },
      type: "function",
    });
  });

  it("adds missing top-level type for raw object-ish MCP schemas", () => {
    const tools = [
      {
        description: "Run a query",
        name: "query",
        parameters: { properties: { q: { type: "string" } }, required: ["q"] },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result[0]?.parameters).toEqual({
      properties: { q: { type: "string" } },
      required: ["q"],
      type: "object",
    });
  });

  it("flattens raw top-level anyOf MCP schemas into one object schema", () => {
    const tools = [
      {
        description: "Dispatch an action",
        name: "dispatch",
        parameters: {
          anyOf: [
            {
              properties: { action: { const: "ping" } },
              required: ["action"],
              type: "object",
            },
            {
              properties: {
                action: { const: "echo" },
                text: { type: "string" },
              },
              required: ["action", "text"],
              type: "object",
            },
          ],
        },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result[0]?.parameters).toEqual({
      additionalProperties: true,
      properties: {
        action: { enum: ["ping", "echo"], type: "string" },
        text: { type: "string" },
      },
      required: ["action"],
      type: "object",
    });
  });

  it("leaves top-level allOf schemas unchanged", () => {
    const tools = [
      {
        description: "Conditional schema",
        name: "conditional",
        parameters: {
          allOf: [{ properties: { id: { type: "string" } }, type: "object" }],
        },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result[0]?.parameters).toEqual({
      allOf: [{ properties: { id: { type: "string" } }, type: "object" }],
    });
  });

  it("preserves existing properties on type:object schemas", () => {
    const tools = [
      {
        description: "Run a command",
        name: "exec",
        parameters: { properties: { cmd: { type: "string" } }, type: "object" },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result[0]?.parameters).toEqual({
      properties: { cmd: { type: "string" } },
      type: "object",
    });
  });

  it("adds strict:true and required:[] for native strict-compatible no-param tools", () => {
    const tools = [
      {
        description: "No params",
        name: "ping",
        parameters: { additionalProperties: false, properties: {}, type: "object" },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0], {
      strict: true,
    });

    expect(result[0]).toEqual({
      description: "No params",
      name: "ping",
      parameters: {
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object",
      },
      strict: true,
      type: "function",
    });
  });

  it("falls back to strict:false for native tools with non-strict-compatible schemas", () => {
    const tools = [
      {
        description: "Read file",
        name: "read",
        parameters: {
          additionalProperties: false,
          properties: { path: { type: "string" } },
          type: "object",
        },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0], {
      strict: true,
    });

    expect(result[0]).toEqual({
      description: "Read file",
      name: "read",
      parameters: {
        additionalProperties: false,
        properties: { path: { type: "string" } },
        type: "object",
      },
      strict: false,
      type: "function",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("convertMessagesToInputItems", () => {
  it("converts a simple user text message", () => {
    const items = convertMessagesToInputItems([userMsg("Hello!")] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ content: "Hello!", role: "user", type: "message" });
  });

  it("converts an assistant text-only message", () => {
    const items = convertMessagesToInputItems([assistantMsg(["Hi there."])] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ content: "Hi there.", role: "assistant", type: "message" });
  });

  it("preserves assistant phase on replayed assistant messages", () => {
    const items = convertMessagesToInputItems([
      assistantMsg(["Working on it."], [], "commentary"),
    ] as Parameters<typeof convertMessagesToInputItems>[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      content: "Working on it.",
      phase: "commentary",
      role: "assistant",
      type: "message",
    });
  });

  it("converts an assistant message with a tool call", () => {
    const msg = assistantMsg(
      ["Let me run that."],
      [{ args: { cmd: "ls" }, id: "call_1", name: "exec" }],
    );
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    // Should produce a text message and a function_call item
    const textItem = items.find((i) => i.type === "message");
    const fcItem = items.find((i) => i.type === "function_call");
    expect(textItem).toBeDefined();
    expect(fcItem).toMatchObject({
      call_id: "call_1",
      name: "exec",
      type: "function_call",
    });
    expect(textItem).not.toHaveProperty("phase");
    const fc = fcItem as { arguments: string };
    expect(JSON.parse(fc.arguments)).toEqual({ cmd: "ls" });
  });

  it("preserves assistant phase on commentary text before tool calls", () => {
    const msg = assistantMsg(
      ["Let me run that."],
      [{ args: { cmd: "ls" }, id: "call_1", name: "exec" }],
      "commentary",
    );
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    const textItem = items.find((i) => i.type === "message");
    expect(textItem).toMatchObject({
      content: "Let me run that.",
      phase: "commentary",
      role: "assistant",
      type: "message",
    });
  });

  it("preserves assistant phase from textSignature metadata without local phase field", () => {
    const msg = {
      api: "openai-responses",
      content: [
        {
          text: "Working on it.",
          textSignature: JSON.stringify({ v: 1, id: "msg_sig", phase: "commentary" }),
          type: "text" as const,
        },
      ],
      model: "gpt-5.4",
      provider: "openai",
      role: "assistant" as const,
      stopReason: "stop",
      timestamp: 0,
      usage: {},
    };
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      content: "Working on it.",
      phase: "commentary",
      role: "assistant",
      type: "message",
    });
  });

  it("splits replayed assistant text on phase changes from block signatures", () => {
    const msg = {
      api: "openai-responses",
      content: [
        {
          text: "Working... ",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
          type: "text" as const,
        },
        {
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
          type: "text" as const,
        },
      ],
      model: "gpt-5.2",
      phase: "final_answer" as const,
      provider: "openai",
      role: "assistant" as const,
      stopReason: "stop",
      timestamp: 0,
      usage: {},
    };

    expect(
      convertMessagesToInputItems([msg] as unknown as Parameters<
        typeof convertMessagesToInputItems
      >[0]),
    ).toEqual([
      {
        content: "Working... ",
        phase: "commentary",
        role: "assistant",
        type: "message",
      },
      {
        content: "Done.",
        phase: "final_answer",
        role: "assistant",
        type: "message",
      },
    ]);
  });

  it("inherits message-level phase for id-only textSignature blocks, merging with phased text", () => {
    const msg = {
      api: "openai-responses",
      content: [
        {
          text: "Replay. ",
          textSignature: JSON.stringify({ v: 1, id: "item_pending_phase" }),
          type: "text" as const,
        },
        {
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
          type: "text" as const,
        },
      ],
      model: "gpt-5.2",
      phase: "final_answer" as const,
      provider: "openai",
      role: "assistant" as const,
      stopReason: "stop",
      timestamp: 0,
      usage: {},
    };

    expect(
      convertMessagesToInputItems([msg] as unknown as Parameters<
        typeof convertMessagesToInputItems
      >[0]),
    ).toEqual([
      {
        content: "Replay. Done.",
        phase: "final_answer",
        role: "assistant",
        type: "message",
      },
    ]);
  });

  it("keeps truly unsigned legacy blocks separate when phased siblings are present", () => {
    const msg = {
      api: "openai-responses",
      content: [
        {
          text: "Legacy. ",
          type: "text" as const,
        },
        {
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
          type: "text" as const,
        },
      ],
      model: "gpt-5.2",
      phase: "final_answer" as const,
      provider: "openai",
      role: "assistant" as const,
      stopReason: "stop",
      timestamp: 0,
      usage: {},
    };

    expect(
      convertMessagesToInputItems([msg] as unknown as Parameters<
        typeof convertMessagesToInputItems
      >[0]),
    ).toEqual([
      {
        content: "Legacy. ",
        role: "assistant",
        type: "message",
      },
      {
        content: "Done.",
        phase: "final_answer",
        role: "assistant",
        type: "message",
      },
    ]);
  });

  it("preserves ordering when commentary text, tool calls, and final answer share one stored assistant message", () => {
    const msg = {
      api: "openai-responses",
      content: [
        {
          text: "Working... ",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
          type: "text" as const,
        },
        {
          arguments: { cmd: "ls" },
          id: "call_1|fc_1",
          name: "exec",
          type: "toolCall" as const,
        },
        {
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
          type: "text" as const,
        },
      ],
      model: "gpt-5.2",
      provider: "openai",
      role: "assistant" as const,
      stopReason: "toolUse",
      timestamp: 0,
      usage: {},
    };

    expect(
      convertMessagesToInputItems([msg] as Parameters<typeof convertMessagesToInputItems>[0]),
    ).toEqual([
      {
        content: "Working... ",
        phase: "commentary",
        role: "assistant",
        type: "message",
      },
      {
        arguments: JSON.stringify({ cmd: "ls" }),
        call_id: "call_1",
        id: "fc_1",
        name: "exec",
        type: "function_call",
      },
      {
        content: "Done.",
        phase: "final_answer",
        role: "assistant",
        type: "message",
      },
    ]);
  });

  it("converts a tool result message", () => {
    const items = convertMessagesToInputItems([toolResultMsg("call_1", "file.txt")] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      call_id: "call_1",
      output: "file.txt",
      type: "function_call_output",
    });
  });

  it("drops tool result messages with empty tool call id", () => {
    const msg = {
      content: [{ text: "output", type: "text" }],
      isError: false,
      role: "toolResult" as const,
      timestamp: 0,
      toolCallId: "   ",
      toolName: "test_tool",
    };
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toEqual([]);
  });

  it("falls back to toolUseId when toolCallId is missing", () => {
    const msg = {
      content: [{ text: "ok", type: "text" }],
      isError: false,
      role: "toolResult" as const,
      timestamp: 0,
      toolName: "test_tool",
      toolUseId: "call_from_tool_use",
    };
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      call_id: "call_from_tool_use",
      output: "ok",
      type: "function_call_output",
    });
  });

  it("converts a full multi-turn conversation", () => {
    const messages: FakeMessage[] = [
      userMsg("Run ls"),
      assistantMsg([], [{ args: { cmd: "ls" }, id: "call_1", name: "exec" }]),
      toolResultMsg("call_1", "file.txt\nfoo.ts"),
    ];
    const items = convertMessagesToInputItems(
      messages as Parameters<typeof convertMessagesToInputItems>[0],
    );

    const userItem = items.find(
      (i) => i.type === "message" && (i as { role?: string }).role === "user",
    );
    const fcItem = items.find((i) => i.type === "function_call");
    const outputItem = items.find((i) => i.type === "function_call_output");

    expect(userItem).toBeDefined();
    expect(fcItem).toBeDefined();
    expect(outputItem).toBeDefined();
  });

  it("handles assistant messages with only tool calls (no text)", () => {
    const msg = assistantMsg([], [{ args: { path: "/etc/hosts" }, id: "call_2", name: "read" }]);
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("function_call");
  });

  it("drops assistant tool calls with empty ids", () => {
    const msg = assistantMsg([], [{ args: { path: "/tmp/a" }, id: "   ", name: "read" }]);
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toEqual([]);
  });

  it("skips thinking blocks in assistant messages", () => {
    const msg = {
      api: "openai-responses",
      content: [
        { thinking: "internal reasoning...", type: "thinking" },
        { text: "Here is my answer.", type: "text" },
      ],
      model: "gpt-5.4",
      provider: "openai",
      role: "assistant" as const,
      stopReason: "stop",
      timestamp: 0,
      usage: {},
    };
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect((items[0] as { content?: unknown }).content).toBe("Here is my answer.");
  });

  it("replays reasoning blocks from thinking signatures", () => {
    const msg = {
      api: "openai-responses",
      content: [
        {
          thinking: "internal reasoning...",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_test",
            summary: [],
          }),
          type: "thinking" as const,
        },
        { text: "Here is my answer.", type: "text" as const },
      ],
      model: "gpt-5.4",
      provider: "openai",
      role: "assistant" as const,
      stopReason: "stop",
      timestamp: 0,
      usage: {},
    };
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items.map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(items[0]).toMatchObject({ id: "rs_test", type: "reasoning" });
  });

  it("replays reasoning blocks when signature type is reasoning.*", () => {
    const msg = {
      api: "openai-responses",
      content: [
        {
          thinking: "internal reasoning...",
          thinkingSignature: JSON.stringify({
            type: "reasoning.summary",
            id: "rs_summary",
          }),
          type: "thinking" as const,
        },
        { text: "Here is my answer.", type: "text" as const },
      ],
      model: "gpt-5.4",
      provider: "openai",
      role: "assistant" as const,
      stopReason: "stop",
      timestamp: 0,
      usage: {},
    };
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items.map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(items[0]).toMatchObject({ id: "rs_summary", type: "reasoning" });
  });

  it("drops reasoning replay ids that do not match OpenAI reasoning ids", () => {
    const msg = {
      api: "openai-responses",
      content: [
        {
          thinking: "internal reasoning...",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "  bad-id  ",
          }),
          type: "thinking" as const,
        },
        { text: "Here is my answer.", type: "text" as const },
      ],
      model: "gpt-5.4",
      provider: "openai",
      role: "assistant" as const,
      stopReason: "stop",
      timestamp: 0,
      usage: {},
    };
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toEqual([
      {
        type: "reasoning",
      },
      {
        content: "Here is my answer.",
        role: "assistant",
        type: "message",
      },
    ]);
  });

  it("returns empty array for empty messages", () => {
    expect(convertMessagesToInputItems([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("buildAssistantMessageFromResponse", () => {
  const modelInfo = { api: "openai-responses", id: "gpt-5.4", provider: "openai" };

  it("extracts text content from a message output item", () => {
    const response = makeResponseObject("resp_1", "Hello from assistant");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content).toHaveLength(1);
    const textBlock = msg.content[0] as { type: string; text: string };
    expect(textBlock.type).toBe("text");
    expect(textBlock.text).toBe("Hello from assistant");
  });

  it("sets stopReason to 'stop' for text-only responses", () => {
    const response = makeResponseObject("resp_1", "Just text");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.stopReason).toBe("stop");
  });

  it("extracts tool call from function_call output item", () => {
    const response = makeResponseObject("resp_2", undefined, "exec");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    const tc = msg.content.find((c) => c.type === "toolCall") as {
      type: string;
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(tc).toBeDefined();
    expect(tc.name).toBe("exec");
    expect(tc.id).toBe("call_abc|item_2");
    expect(tc.arguments).toEqual({ arg: "value" });
  });

  it("sets stopReason to 'toolUse' when tool calls are present", () => {
    const response = makeResponseObject("resp_3", undefined, "exec");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.stopReason).toBe("toolUse");
  });

  it("includes both text and tool calls when both present", () => {
    const response = makeResponseObject("resp_4", "Running...", "exec");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content.some((c) => c.type === "text")).toBe(true);
    expect(msg.content.some((c) => c.type === "toolCall")).toBe(true);
    expect(msg.stopReason).toBe("toolUse");
  });

  it("maps usage tokens correctly", () => {
    const response = makeResponseObject("resp_5", "Hello");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.usage.input).toBe(100);
    expect(msg.usage.output).toBe(50);
    expect(msg.usage.totalTokens).toBe(150);
  });

  it("maps prompt_tokens and completion_tokens usage aliases", () => {
    const response = makeResponseObject("resp_5b", "Hello");
    response.usage = {
      completion_tokens: 11,
      prompt_tokens: 44,
      total_tokens: 55,
    };

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.usage.input).toBe(44);
    expect(msg.usage.output).toBe(11);
    expect(msg.usage.totalTokens).toBe(55);
  });

  it("falls back to normalized input and output when total_tokens is missing", () => {
    const response = makeResponseObject("resp_5c", "Hello");
    response.usage = {
      completion_tokens: 5,
      prompt_tokens: 10,
    };

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.usage.input).toBe(10);
    expect(msg.usage.output).toBe(5);
    expect(msg.usage.totalTokens).toBe(15);
  });

  it("falls back to normalized input and output when total_tokens is zero", () => {
    const response = makeResponseObject("resp_5d", "Hello");
    response.usage = {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 0,
    };

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.usage.input).toBe(10);
    expect(msg.usage.output).toBe(5);
    expect(msg.usage.totalTokens).toBe(15);
  });

  it("sets model/provider/api from modelInfo", () => {
    const response = makeResponseObject("resp_6", "Hi");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.api).toBe("openai-responses");
    expect(msg.provider).toBe("openai");
    expect(msg.model).toBe("gpt-5.4");
  });

  it("handles empty output gracefully", () => {
    const response = makeResponseObject("resp_7");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content).toEqual([]);
    expect(msg.stopReason).toBe("stop");
  });

  it("preserves phase from assistant message output items", () => {
    const response = makeResponseObject("resp_8", "Final answer", undefined, "final_answer");
    const msg = buildAssistantMessageFromResponse(response, modelInfo) as {
      phase?: string;
      content: { type: string; text?: string }[];
    };
    expect(msg.phase).toBe("final_answer");
    expect(msg.content[0]?.text).toBe("Final answer");
  });

  it("keeps only final-answer text when a response contains mixed assistant phases", () => {
    const response = {
      created_at: Date.now(),
      id: "resp_mixed_phase",
      model: "gpt-5.2",
      object: "response",
      output: [
        {
          content: [{ type: "output_text", text: "Working... " }],
          id: "item_commentary",
          phase: "commentary",
          role: "assistant",
          type: "message",
        },
        {
          content: [{ type: "output_text", text: "Done." }],
          id: "item_final",
          phase: "final_answer",
          role: "assistant",
          type: "message",
        },
      ],
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo) as {
      phase?: string;
      content: { type: string; text?: string; textSignature?: string }[];
    };

    expect(msg.phase).toBe("final_answer");
    expect(msg.content).toMatchObject([
      {
        text: "Done.",
        textSignature: JSON.stringify({ id: "item_final", phase: "final_answer", v: 1 }),
        type: "text",
      },
    ]);
  });

  it("keeps only phased final text when unphased legacy text and phased final text coexist", () => {
    const response = {
      created_at: Date.now(),
      id: "resp_unphased_plus_final",
      model: "gpt-5.2",
      object: "response",
      output: [
        {
          content: [{ type: "output_text", text: "Legacy. " }],
          id: "item_legacy",
          role: "assistant",
          type: "message",
        },
        {
          content: [{ type: "output_text", text: "Done." }],
          id: "item_final",
          phase: "final_answer",
          role: "assistant",
          type: "message",
        },
      ],
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo) as {
      phase?: string;
      content: { type: string; text?: string; textSignature?: string }[];
    };

    expect(msg.phase).toBe("final_answer");
    expect(msg.content).toMatchObject([
      {
        text: "Done.",
        textSignature: JSON.stringify({ id: "item_final", phase: "final_answer", v: 1 }),
        type: "text",
      },
    ]);
  });

  it("drops commentary-only text from completed assistant messages but keeps tool calls", () => {
    const response = {
      created_at: Date.now(),
      id: "resp_commentary_only_tool",
      model: "gpt-5.2",
      object: "response",
      output: [
        {
          content: [{ type: "output_text", text: "Working... " }],
          id: "item_commentary",
          phase: "commentary",
          role: "assistant",
          type: "message",
        },
        {
          arguments: '{"arg":"value"}',
          call_id: "call_abc",
          id: "item_tool",
          name: "exec",
          type: "function_call",
        },
      ],
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo) as {
      phase?: string;
      content: { type: string; text?: string; name?: string }[];
      stopReason: string;
    };

    expect(msg.phase).toBeUndefined();
    expect(msg.content.some((part) => part.type === "text")).toBe(false);
    expect(msg.content).toMatchObject([{ name: "exec", type: "toolCall" }]);
    expect(msg.stopReason).toBe("toolUse");
  });

  it("maps reasoning output items to thinking blocks with signature", () => {
    const response = {
      created_at: Date.now(),
      id: "resp_reasoning",
      model: "gpt-5.4",
      object: "response",
      output: [
        {
          id: "rs_123",
          summary: [{ text: "Plan step A" }, { text: "Plan step B" }],
          type: "reasoning",
        },
        {
          content: [{ type: "output_text", text: "Final answer" }],
          id: "item_1",
          role: "assistant",
          type: "message",
        },
      ],
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    const thinkingBlock = msg.content.find((c) => c.type === "thinking") as
      | { type: "thinking"; thinking: string; thinkingSignature?: string }
      | undefined;
    expect(thinkingBlock?.thinking).toBe("Plan step A\nPlan step B");
    expect(thinkingBlock?.thinkingSignature).toBe(
      JSON.stringify({ id: "rs_123", type: "reasoning" }),
    );
  });

  it("maps reasoning.* output items to thinking blocks", () => {
    const response = {
      created_at: Date.now(),
      id: "resp_reasoning_kind",
      model: "gpt-5.4",
      object: "response",
      output: [
        {
          content: "Derived hidden reasoning",
          id: "rs_456",
          type: "reasoning.summary",
        },
      ],
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    const thinkingBlock = msg.content[0] as
      | { type: "thinking"; thinking: string; thinkingSignature?: string }
      | undefined;
    expect(thinkingBlock?.type).toBe("thinking");
    expect(thinkingBlock?.thinking).toBe("Derived hidden reasoning");
    expect(thinkingBlock?.thinkingSignature).toBe(
      JSON.stringify({ id: "rs_456", type: "reasoning.summary" }),
    );
  });

  it("prefers reasoning summary text over fallback content and preserves item order", () => {
    const response = {
      created_at: Date.now(),
      id: "resp_reasoning_order",
      model: "gpt-5.4",
      object: "response",
      output: [
        {
          content: "hidden fallback content",
          id: "rs_789",
          summary: ["Plan A", { text: "Plan B" }, { nope: true }],
          type: "reasoning.summary",
        },
        {
          arguments: '{"arg":"value"}',
          call_id: "call_789",
          id: "fc_789",
          name: "exec",
          type: "function_call",
        },
      ],
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content.map((block) => block.type)).toEqual(["thinking", "toolCall"]);
    const thinkingBlock = msg.content[0] as
      | { type: "thinking"; thinking: string; thinkingSignature?: string }
      | undefined;
    expect(thinkingBlock?.thinking).toBe("Plan A\nPlan B");
    expect(thinkingBlock?.thinkingSignature).toBe(
      JSON.stringify({ id: "rs_789", type: "reasoning.summary" }),
    );
  });

  it("drops invalid reasoning ids from thinking signatures while preserving the visible block", () => {
    const response = {
      created_at: Date.now(),
      id: "resp_invalid_reasoning_id",
      model: "gpt-5.4",
      object: "response",
      output: [
        {
          content: "Hidden reasoning",
          id: "invalid_reasoning_id",
          type: "reasoning",
        },
      ],
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content).toEqual([{ thinking: "Hidden reasoning", type: "thinking" }]);
  });

  it("preserves function call item ids for replay when reasoning is present", () => {
    const response = {
      created_at: Date.now(),
      id: "resp_tool_reasoning",
      model: "gpt-5.4",
      object: "response",
      output: [
        {
          content: "Thinking before tool call",
          id: "rs_tool",
          type: "reasoning",
        },
        {
          arguments: '{"arg":"value"}',
          call_id: "call_tool",
          id: "fc_tool",
          name: "exec",
          type: "function_call",
        },
      ],
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as ResponseObject;

    const assistant = buildAssistantMessageFromResponse(response, modelInfo);
    const toolCall = assistant.content.find((item) => item.type === "toolCall") as
      | { type: "toolCall"; id: string }
      | undefined;
    expect(toolCall?.id).toBe("call_tool|fc_tool");

    const replayItems = convertMessagesToInputItems([assistant] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(replayItems.map((item) => item.type)).toEqual(["reasoning", "function_call"]);
    expect(replayItems[1]).toMatchObject({
      call_id: "call_tool",
      id: "fc_tool",
      type: "function_call",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("planTurnInput", () => {
  const replayModel = { input: ["text"] };

  it("uses incremental tool result replay when a previous response id and new tool results exist", () => {
    const context = {
      messages: [
        userMsg("Run ls"),
        assistantMsg([], [{ args: { cmd: "ls" }, id: "call_1|fc_1", name: "exec" }]),
        toolResultMsg("call_1|fc_1", "file.txt"),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      systemPrompt: "You are helpful.",
      tools: [],
    };

    const turnInput = planTurnInput({
      context,
      lastContextLength: 2,
      model: replayModel,
      previousResponseId: "resp_prev",
    });

    expect(turnInput.mode).toBe("incremental_tool_results");
    expect(turnInput.previousResponseId).toBe("resp_prev");
    expect(turnInput.inputItems).toEqual([
      {
        call_id: "call_1",
        output: "file.txt",
        type: "function_call_output",
      },
    ]);
  });

  it("restarts with full context when follow-up turns have no new tool results", () => {
    const turn1Response = {
      created_at: Date.now(),
      id: "resp_turn1_reasoning",
      model: "gpt-5.4",
      object: "response",
      output: [
        {
          content: "Thinking before tool call",
          id: "rs_turn1",
          type: "reasoning",
        },
        {
          arguments: '{"cmd":"ls"}',
          call_id: "call_turn1",
          id: "fc_turn1",
          name: "exec",
          type: "function_call",
        },
      ],
      status: "completed",
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    } as ResponseObject;

    const context = {
      messages: [
        userMsg("Run ls"),
        buildAssistantMessageFromResponse(turn1Response, {
          api: "openai-responses",
          id: "gpt-5.4",
          provider: "openai",
        }),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      systemPrompt: "You are helpful.",
      tools: [],
    };

    const turnInput = planTurnInput({
      context,
      lastContextLength: context.messages.length,
      model: replayModel,
      previousResponseId: "resp_turn1_reasoning",
    });

    expect(turnInput.mode).toBe("full_context_restart");
    expect(turnInput.previousResponseId).toBeUndefined();
    expect(turnInput.inputItems.map((item) => item.type)).toEqual([
      "message",
      "reasoning",
      "function_call",
    ]);
    expect(turnInput.inputItems[1]).toMatchObject({ id: "rs_turn1", type: "reasoning" });
    expect(turnInput.inputItems[2]).toMatchObject({
      call_id: "call_turn1",
      id: "fc_turn1",
      type: "function_call",
    });
  });

  it("uses full context on the initial turn", () => {
    const context = {
      messages: [userMsg("Hello!")] as Parameters<typeof convertMessagesToInputItems>[0],
      systemPrompt: "You are helpful.",
      tools: [],
    };

    const turnInput = planTurnInput({
      context,
      lastContextLength: 0,
      model: replayModel,
      previousResponseId: null,
    });

    expect(turnInput).toMatchObject({
      inputItems: [{ content: "Hello!", role: "user", type: "message" }],
      mode: "full_context_initial",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenAIWebSocketStreamFn", () => {
  const modelStub = {
    api: "openai-responses",
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: "gpt-5.4",
    input: ["text"],
    maxTokens: 4096,
    name: "GPT-5.2",
    provider: "openai",
    reasoning: false,
  };

  const contextStub = {
    messages: [userMsg("Hello!") as Parameters<typeof convertMessagesToInputItems>[0][number]],
    systemPrompt: "You are helpful.",
    tools: [],
  };

  beforeEach(() => {
    MockManager.reset();
    streamSimpleCalls.length = 0;
    mockCreateHttpFallbackStreamFn.mockReset();
    mockCreateHttpFallbackStreamFn.mockReturnValue(mockStreamSimple as never);
    openAIWsStreamTesting.setDepsForTest({
      createHttpFallbackStreamFn: mockCreateHttpFallbackStreamFn as never,
      createManager: ((options?: unknown) => new MockManager(options)) as never,
      streamSimple: mockStreamSimple,
    });
  });

  afterEach(() => {
    // Clean up any sessions created in tests to avoid cross-test pollution
    MockManager.instances.forEach((_, i) => {
      // Session IDs used in tests follow a predictable pattern
      releaseWsSession(`test-session-${i}`);
    });
    releaseWsSession("sess-1");
    releaseWsSession("sess-2");
    releaseWsSession("sess-boundary");
    releaseWsSession("sess-fallback");
    releaseWsSession("sess-boundary-http-fallback");
    releaseWsSession("sess-full-context-replay");
    releaseWsSession("sess-incremental");
    releaseWsSession("sess-full");
    releaseWsSession("sess-onpayload");
    releaseWsSession("sess-onpayload-async");
    releaseWsSession("sess-phase");
    releaseWsSession("sess-phase-stream");
    releaseWsSession("sess-phase-late-map");
    releaseWsSession("sess-reason");
    releaseWsSession("sess-reason-none");
    releaseWsSession("sess-tools");
    releaseWsSession("sess-store-default");
    releaseWsSession("sess-store-compat");
    releaseWsSession("sess-store-proxy");
    releaseWsSession("sess-max-tokens-zero");
    releaseWsSession("sess-runtime-fallback-nested");
    releaseWsSession("sess-runtime-fallback");
    releaseWsSession("sess-runtime-retry");
    releaseWsSession("sess-send-fail-reset");
    releaseWsSession("sess-temp");
    releaseWsSession("sess-text-verbosity");
    releaseWsSession("sess-text-verbosity-invalid");
    releaseWsSession("sess-topp");
    releaseWsSession("sess-turn-metadata-retry");
    releaseWsSession("sess-warmup-disabled");
    releaseWsSession("sess-warmup-enabled");
    releaseWsSession("sess-degraded-cooldown");
    releaseWsSession("sess-drop");
    openAIWsStreamTesting.setWsDegradeCooldownMsForTest();
    openAIWsStreamTesting.setDepsForTest();
  });

  it("connects to the WebSocket on first call", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-1");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    // Give the microtask queue time to run
    await new Promise((r) => setImmediate(r));

    const manager = MockManager.lastInstance;
    expect(manager?.connectCallCount).toBe(1);
    releaseWsSession("sess-1");
    for await (const _ of await resolveStream(stream)) {
      // Consume
    }
  });

  it("sends a response.create event on first turn (full context)", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-full");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const completed = new Promise<void>((res, rej) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          const manager = MockManager.lastInstance!;

          // Simulate the server completing the response
          manager.simulateEvent({
            response: makeResponseObject("resp_1", "Hello!"),
            type: "response.completed",
          });

          for await (const _ of await resolveStream(stream)) {
            // Consume events
          }
          res();
        } catch (error) {
          rej(error);
        }
      });
    });

    await completed;

    const manager = MockManager.lastInstance!;
    expect(manager.sentEvents).toHaveLength(1);
    const sent = manager.sentEvents[0] as { type: string; model: string; input: unknown[] };
    expect(sent.type).toBe("response.create");
    expect(sent.model).toBe("gpt-5.4");
    expect(Array.isArray(sent.input)).toBe(true);
  });

  it("includes store:false by default", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-store-default");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const completed = new Promise<void>((res, rej) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          const manager = MockManager.lastInstance!;
          manager.simulateEvent({
            response: makeResponseObject("resp_store_default", "ok"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            // Consume
          }
          res();
        } catch (error) {
          rej(error);
        }
      });
    });
    await completed;

    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.store).toBe(false);
  });

  it("omits store when compat.supportsStore is false (#39086)", async () => {
    releaseWsSession("sess-store-compat");
    const noStoreModel = {
      ...modelStub,
      compat: { supportsStore: false },
    };
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-store-compat");
    const stream = streamFn(
      noStoreModel as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const completed = new Promise<void>((res, rej) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          const manager = MockManager.lastInstance!;
          manager.simulateEvent({
            response: makeResponseObject("resp_no_store", "ok"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            // Consume
          }
          res();
        } catch (error) {
          rej(error);
        }
      });
    });
    await completed;

    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("store");
  });

  it("keeps store=false for proxied openai-responses routes when store is still supported", () => {
    const proxiedModel = {
      ...modelStub,
      baseUrl: "https://proxy.example.com/v1",
    };
    const turnInput = planTurnInput({
      context: contextStub as Parameters<typeof planTurnInput>[0]["context"],
      lastContextLength: 0,
      model: proxiedModel as Parameters<typeof planTurnInput>[0]["model"],
      previousResponseId: null,
    });
    const sent = buildOpenAIWebSocketResponseCreatePayload({
      context: contextStub as Parameters<
        typeof buildOpenAIWebSocketResponseCreatePayload
      >[0]["context"],
      model: proxiedModel as Parameters<
        typeof buildOpenAIWebSocketResponseCreatePayload
      >[0]["model"],
      tools: [],
      turnInput,
    }) as Record<string, unknown>;
    expect(sent.store).toBe(false);
  });

  it("emits an AssistantMessage on response.completed", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-2");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: unknown[] = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      response: makeResponseObject("resp_hello", "Hello back!"),
      type: "response.completed",
    });

    await done;

    const doneEvent = events.find((e) => (e as { type?: string }).type === "done") as
      | {
          type: string;
          reason: string;
          message: { content: { text: string }[] };
        }
      | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.message.content[0]?.text).toBe("Hello back!");
  });

  it("suppresses commentary-only text on completed WebSocket responses", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phase");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: unknown[] = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      response: makeResponseObject("resp_phase", "Working...", "exec", "commentary"),
      type: "response.completed",
    });

    await done;

    const doneEvent = events.find((e) => (e as { type?: string }).type === "done") as
      | {
          type: string;
          reason: string;
          message: { phase?: string; stopReason: string; content?: { type?: string }[] };
        }
      | undefined;
    expect(doneEvent?.message.phase).toBeUndefined();
    expect(doneEvent?.message.content?.some((part) => part.type === "text")).toBe(false);
    expect(doneEvent?.message.stopReason).toBe("toolUse");
  });

  it("emits accumulated phase-aware partials when output item mapping is available", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phase-stream");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: {
      type?: string;
      delta?: string;
      partial?: { phase?: string; content?: unknown[] };
    }[] = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev as (typeof events)[number]);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      item: {
        content: [],
        id: "item_commentary",
        phase: "commentary",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.added",
    });
    manager.simulateEvent({
      content_index: 0,
      delta: "Working",
      item_id: "item_commentary",
      output_index: 0,
      type: "response.output_text.delta",
    });
    manager.simulateEvent({
      content_index: 0,
      delta: "...",
      item_id: "item_commentary",
      output_index: 0,
      type: "response.output_text.delta",
    });
    manager.simulateEvent({
      item: {
        content: [],
        id: "item_final",
        phase: "final_answer",
        role: "assistant",
        type: "message",
      },
      output_index: 1,
      type: "response.output_item.added",
    });
    manager.simulateEvent({
      content_index: 0,
      delta: "Done.",
      item_id: "item_final",
      output_index: 1,
      type: "response.output_text.delta",
    });
    manager.simulateEvent({
      response: {
        created_at: Date.now(),
        id: "resp_phase_stream",
        model: "gpt-5.2",
        object: "response",
        output: [
          {
            content: [{ type: "output_text", text: "Working..." }],
            id: "item_commentary",
            phase: "commentary",
            role: "assistant",
            type: "message",
          },
          {
            content: [{ type: "output_text", text: "Done." }],
            id: "item_final",
            phase: "final_answer",
            role: "assistant",
            type: "message",
          },
        ],
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
      type: "response.completed",
    });

    await done;

    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas).toHaveLength(3);
    expect(deltas[0]).toMatchObject({ delta: "Working" });
    expect(deltas[0]?.partial?.phase).toBe("commentary");
    expect(deltas[0]?.partial?.content).toEqual([
      {
        text: "Working",
        textSignature: JSON.stringify({ id: "item_commentary", phase: "commentary", v: 1 }),
        type: "text",
      },
    ]);
    expect(deltas[1]).toMatchObject({ delta: "..." });
    expect(deltas[1]?.partial?.phase).toBe("commentary");
    expect(deltas[1]?.partial?.content).toEqual([
      {
        text: "Working...",
        textSignature: JSON.stringify({ id: "item_commentary", phase: "commentary", v: 1 }),
        type: "text",
      },
    ]);
    expect(deltas[2]).toMatchObject({ delta: "Done." });
    expect(deltas[2]?.partial?.phase).toBe("final_answer");
    expect(deltas[2]?.partial?.content).toEqual([
      {
        text: "Done.",
        textSignature: JSON.stringify({ id: "item_final", phase: "final_answer", v: 1 }),
        type: "text",
      },
    ]);
  });

  it("buffers text deltas until item mapping is available", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phase-late-map");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: {
      type?: string;
      delta?: string;
      partial?: { phase?: string; content?: unknown[] };
    }[] = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev as (typeof events)[number]);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      content_index: 0,
      delta: "Working",
      item_id: "item_late",
      output_index: 0,
      type: "response.output_text.delta",
    });
    manager.simulateEvent({
      item: {
        content: [],
        id: "item_late",
        phase: "commentary",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.added",
    });
    manager.simulateEvent({
      content_index: 0,
      delta: "...",
      item_id: "item_late",
      output_index: 0,
      type: "response.output_text.delta",
    });
    manager.simulateEvent({
      response: {
        created_at: Date.now(),
        id: "resp_phase_late_map",
        model: "gpt-5.2",
        object: "response",
        output: [
          {
            content: [{ type: "output_text", text: "Working..." }],
            id: "item_late",
            phase: "commentary",
            role: "assistant",
            type: "message",
          },
        ],
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
      type: "response.completed",
    });

    await done;

    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ delta: "Working" });
    expect(deltas[0]?.partial?.phase).toBe("commentary");
    expect(deltas[0]?.partial?.content).toEqual([
      {
        text: "Working",
        textSignature: JSON.stringify({ id: "item_late", phase: "commentary", v: 1 }),
        type: "text",
      },
    ]);
    expect(deltas[1]).toMatchObject({ delta: "..." });
    expect(deltas[1]?.partial?.phase).toBe("commentary");
    expect(deltas[1]?.partial?.content).toEqual([
      {
        text: "Working...",
        textSignature: JSON.stringify({ id: "item_late", phase: "commentary", v: 1 }),
        type: "text",
      },
    ]);
  });

  it("keeps buffering text deltas until item phase is defined", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phase-late-map-undefined");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: {
      type?: string;
      delta?: string;
      partial?: { phase?: string; content?: unknown[] };
    }[] = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev as (typeof events)[number]);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      content_index: 0,
      delta: "Working",
      item_id: "item_late_undefined",
      output_index: 0,
      type: "response.output_text.delta",
    });
    manager.simulateEvent({
      item: {
        content: [],
        id: "item_late_undefined",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.added",
    });
    manager.simulateEvent({
      content_index: 0,
      delta: "...",
      item_id: "item_late_undefined",
      output_index: 0,
      type: "response.output_text.delta",
    });

    await new Promise((r) => setImmediate(r));
    const prematureDeltas = events.filter((event) => event.type === "text_delta");
    expect(prematureDeltas).toHaveLength(0);

    manager.simulateEvent({
      item: {
        content: [],
        id: "item_late_undefined",
        phase: "commentary",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.done",
    });
    manager.simulateEvent({
      response: {
        created_at: Date.now(),
        id: "resp_phase_late_map_undefined",
        model: "gpt-5.4",
        object: "response",
        output: [
          {
            content: [{ type: "output_text", text: "Working..." }],
            id: "item_late_undefined",
            phase: "commentary",
            role: "assistant",
            type: "message",
          },
        ],
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
      type: "response.completed",
    });

    await done;

    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ delta: "Working..." });
    expect(deltas[0]?.partial?.phase).toBe("commentary");
    expect(deltas[0]?.partial?.content).toEqual([
      {
        text: "Working...",
        textSignature: JSON.stringify({
          id: "item_late_undefined",
          phase: "commentary",
          v: 1,
        }),
        type: "text",
      },
    ]);
  });
  it("buffers text when output_item.added arrives without phase metadata", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phaseless-gate");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: {
      type?: string;
      delta?: string;
      partial?: { phase?: string; content?: unknown[] };
    }[] = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev as (typeof events)[number]);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;

    // Output_item.added WITHOUT phase — simulates phaseless announcement
    manager.simulateEvent({
      item: {
        content: [],
        id: "item_phaseless",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.added",
    });

    // Text delta arrives while phase is still unknown
    manager.simulateEvent({
      content_index: 0,
      delta: "Leaked?",
      item_id: "item_phaseless",
      output_index: 0,
      type: "response.output_text.delta",
    });

    // Yield to let any would-be emissions propagate
    await new Promise((r) => setImmediate(r));
    const prematureDeltas = events.filter((e) => e.type === "text_delta");
    expect(prematureDeltas).toHaveLength(0);

    // Output_item.done delivers the actual phase — should flush buffered text
    manager.simulateEvent({
      item: {
        content: [{ text: "Leaked?", type: "output_text" }],
        id: "item_phaseless",
        phase: "commentary",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.done",
    });

    manager.simulateEvent({
      response: {
        created_at: Date.now(),
        id: "resp_phaseless_gate",
        model: "gpt-5.4",
        object: "response",
        output: [
          {
            content: [{ type: "output_text", text: "Leaked?" }],
            id: "item_phaseless",
            phase: "commentary",
            role: "assistant",
            type: "message",
          },
        ],
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      type: "response.completed",
    });

    await done;

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ delta: "Leaked?" });
    expect(deltas[0]?.partial?.phase).toBe("commentary");
  });

  it("buffers output_text.done until item phase is defined", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phaseless-done-gate");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: {
      type?: string;
      delta?: string;
      partial?: { phase?: string; content?: unknown[] };
    }[] = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev as (typeof events)[number]);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;

    manager.simulateEvent({
      item: {
        content: [],
        id: "item_phaseless_done",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.added",
    });
    manager.simulateEvent({
      content_index: 0,
      item_id: "item_phaseless_done",
      output_index: 0,
      text: "Buffered final text",
      type: "response.output_text.done",
    });

    await new Promise((r) => setImmediate(r));
    const prematureDeltas = events.filter((event) => event.type === "text_delta");
    expect(prematureDeltas).toHaveLength(0);

    manager.simulateEvent({
      item: {
        content: [{ text: "Buffered final text", type: "output_text" }],
        id: "item_phaseless_done",
        phase: "commentary",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.done",
    });
    manager.simulateEvent({
      response: {
        created_at: Date.now(),
        id: "resp_phaseless_done_gate",
        model: "gpt-5.4",
        object: "response",
        output: [
          {
            content: [{ type: "output_text", text: "Buffered final text" }],
            id: "item_phaseless_done",
            phase: "commentary",
            role: "assistant",
            type: "message",
          },
        ],
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      type: "response.completed",
    });

    await done;

    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ delta: "Buffered final text" });
    expect(deltas[0]?.partial?.phase).toBe("commentary");
  });

  it("falls back to HTTP when WebSocket connect fails (session pre-broken via flag)", async () => {
    // Set the class-level flag BEFORE calling streamFn so the new instance
    // Fails on connect().  We patch the static default via MockManager directly.
    MockManager.globalConnectShouldFail = true;

    try {
      const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-fallback");
      const stream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
      );

      // Consume — should fall back to HTTP (streamSimple mock).
      const messages: unknown[] = [];
      for await (const ev of await resolveStream(stream)) {
        messages.push(ev);
      }

      // StreamSimple was called as part of HTTP fallback
      expect(streamSimpleCalls.length).toBeGreaterThanOrEqual(1);

      // The failed manager is closed before the replacement session manager is installed.
      expect(MockManager.instances.some((instance) => instance.closeCallCount >= 1)).toBe(true);
    } finally {
      MockManager.globalConnectShouldFail = false;
    }
  });

  it("falls back to HTTP when WebSocket errors before any output in auto mode", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-runtime-fallback");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "auto" } as Parameters<typeof streamFn>[2],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      code: "ws_runtime_error",
      message: "temporary upstream glitch",
      type: "error",
    });

    const events: { type?: string; message?: { content?: { text?: string }[] } }[] = [];
    for await (const ev of await resolveStream(stream)) {
      events.push(ev as { type?: string; message?: { content?: { text?: string }[] } });
    }

    expect(streamSimpleCalls.length).toBeGreaterThanOrEqual(1);
    expect(manager.closeCallCount).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent?.message?.content?.[0]?.text).toBe("http fallback response");
  });

  it("falls back to HTTP when OpenAI sends a nested websocket error payload", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-runtime-fallback-nested");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "auto" } as Parameters<typeof streamFn>[2],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      error: {
        code: "previous_response_not_found",
        message: "Previous response with id 'resp_abc' not found.",
        param: "previous_response_id",
        type: "invalid_request_error",
      },
      status: 400,
      type: "error",
    });

    const events: { type?: string; message?: { content?: { text?: string }[] } }[] = [];
    for await (const ev of await resolveStream(stream)) {
      events.push(ev as { type?: string; message?: { content?: { text?: string }[] } });
    }

    expect(streamSimpleCalls.length).toBeGreaterThanOrEqual(1);
    expect(manager.closeCallCount).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent?.message?.content?.[0]?.text).toBe("http fallback response");
  });

  it("retries one retryable mid-request close before falling back in auto mode", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-runtime-retry");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "auto" } as Parameters<typeof streamFn>[2],
    );

    await new Promise((r) => setImmediate(r));
    const firstManager = MockManager.lastInstance!;
    firstManager.simulateClose(1006, "connection lost");

    await new Promise((r) => setImmediate(r));
    const secondManager = MockManager.lastInstance!;
    expect(secondManager).not.toBe(firstManager);
    expect(secondManager.connectCallCount).toBe(1);

    secondManager.simulateEvent({
      response: makeResponseObject("resp-retried", "retry succeeded"),
      type: "response.completed",
    });

    const events: { type?: string; message?: { content?: { text?: string }[] } }[] = [];
    for await (const ev of await resolveStream(stream)) {
      events.push(ev as { type?: string; message?: { content?: { text?: string }[] } });
    }

    expect(streamSimpleCalls).toHaveLength(0);
    expect(firstManager.closeCallCount).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent?.message?.content?.[0]?.text).toBe("retry succeeded");
  });

  it("keeps native turn metadata stable across websocket retries and increments attempt", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-turn-metadata-retry");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "auto" } as Parameters<typeof streamFn>[2],
    );

    await new Promise((r) => setImmediate(r));
    const firstManager = MockManager.lastInstance!;
    firstManager.simulateClose(1006, "connection lost");

    await new Promise((r) => setImmediate(r));
    const secondManager = MockManager.lastInstance!;
    secondManager.simulateEvent({
      response: makeResponseObject("resp-retried-meta", "retry succeeded"),
      type: "response.completed",
    });

    for await (const _ of await resolveStream(stream)) {
      // Consume
    }

    const firstPayload = firstManager.sentEvents[0] as { metadata?: Record<string, string> };
    const secondPayload = secondManager.sentEvents[0] as { metadata?: Record<string, string> };
    expect(firstPayload.metadata?.openclaw_session_id).toBe("sess-turn-metadata-retry");
    expect(firstPayload.metadata?.openclaw_transport).toBe("websocket");
    expect(firstPayload.metadata?.openclaw_turn_id).toBeTruthy();
    expect(secondPayload.metadata?.openclaw_turn_id).toBe(firstPayload.metadata?.openclaw_turn_id);
    expect(firstPayload.metadata?.openclaw_turn_attempt).toBe("1");
    expect(secondPayload.metadata?.openclaw_turn_attempt).toBe("2");
  });

  it("keeps websocket degraded for the session until the cool-down expires", async () => {
    openAIWsStreamTesting.setWsDegradeCooldownMsForTest(50);
    MockManager.globalConnectShouldFail = true;

    try {
      const sessionId = "sess-degraded-cooldown";
      const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

      const firstStream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
        { transport: "auto" } as Parameters<typeof streamFn>[2],
      );
      void firstStream;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(streamSimpleCalls.length).toBe(1);
      expect(MockManager.instances).toHaveLength(2);
      const cooledManager = MockManager.lastInstance!;
      expect(cooledManager.connectCallCount).toBe(0);

      MockManager.globalConnectShouldFail = false;

      const secondStream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
        { transport: "auto" } as Parameters<typeof streamFn>[2],
      );
      void secondStream;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(streamSimpleCalls.length).toBe(2);
      expect(MockManager.instances).toHaveLength(2);
      expect(cooledManager.connectCallCount).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 60));

      const thirdStream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
        { transport: "auto" } as Parameters<typeof streamFn>[2],
      );

      void thirdStream;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(cooledManager.connectCallCount).toBe(1);
      expect(streamSimpleCalls.length).toBe(2);
      cooledManager.simulateEvent({
        response: makeResponseObject("resp-after-cooldown", "ws recovered"),
        type: "response.completed",
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      MockManager.globalConnectShouldFail = false;
      openAIWsStreamTesting.setWsDegradeCooldownMsForTest();
      releaseWsSession("sess-degraded-cooldown");
      releaseWsSession("sess-turn-metadata-retry");
    }
  });

  it("tracks previous_response_id across turns (incremental send)", async () => {
    const sessionId = "sess-incremental";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    // ── Turn 1: full context ─────────────────────────────────────────────
    const ctx1 = {
      messages: [userMsg("Run ls")] as Parameters<typeof convertMessagesToInputItems>[0],
      systemPrompt: "You are helpful.",
      tools: [],
    };

    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx1 as Parameters<typeof streamFn>[1],
    );

    const events1: unknown[] = [];
    const done1 = (async () => {
      for await (const ev of await resolveStream(stream1)) {
        events1.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;

    // Server responds with a tool call
    const turn1Response = makeResponseObject("resp_turn1", undefined, "exec");
    manager.setPreviousResponseId("resp_turn1");
    manager.simulateEvent({ response: turn1Response, type: "response.completed" });
    await done1;

    // ── Turn 2: incremental (tool results only) ───────────────────────────
    const ctx2 = {
      messages: [
        userMsg("Run ls"),
        assistantMsg([], [{ args: { cmd: "ls" }, id: "call_1", name: "exec" }]),
        toolResultMsg("call_1", "file.txt"),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      systemPrompt: "You are helpful.",
      tools: [],
    };

    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx2 as Parameters<typeof streamFn>[1],
    );

    const events2: unknown[] = [];
    const done2 = (async () => {
      for await (const ev of await resolveStream(stream2)) {
        events2.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    manager.simulateEvent({
      response: makeResponseObject("resp_turn2", "Here are the files."),
      type: "response.completed",
    });
    await done2;

    // Turn 2 should have sent previous_response_id and only tool results
    expect(manager.sentEvents).toHaveLength(2);
    const sent2 = manager.sentEvents[1] as {
      previous_response_id?: string;
      input: { type: string }[];
    };
    expect(sent2.previous_response_id).toBe("resp_turn1");
    // Input should only contain tool results, not the full history
    const inputTypes = (sent2.input ?? []).map((i) => i.type);
    expect(inputTypes.every((t) => t === "function_call_output")).toBe(true);
    expect(inputTypes).toHaveLength(1);
  });

  it("omits previous_response_id when replaying full context on follow-up turns", async () => {
    const sessionId = "sess-full-context-replay";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    const ctx1 = {
      messages: [userMsg("Run ls")] as Parameters<typeof convertMessagesToInputItems>[0],
      systemPrompt: "You are helpful.",
      tools: [],
    };

    const turn1Response = {
      created_at: Date.now(),
      id: "resp_turn1_reasoning",
      model: "gpt-5.4",
      object: "response",
      output: [
        {
          content: "Thinking before tool call",
          id: "rs_turn1",
          type: "reasoning",
        },
        {
          arguments: '{"cmd":"ls"}',
          call_id: "call_turn1",
          id: "fc_turn1",
          name: "exec",
          type: "function_call",
        },
      ],
      status: "completed",
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    } as ResponseObject;

    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx1 as Parameters<typeof streamFn>[1],
    );
    const done1 = (async () => {
      for await (const _ of await resolveStream(stream1)) {
        /* Consume */
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.setPreviousResponseId("resp_turn1_reasoning");
    manager.simulateEvent({ response: turn1Response, type: "response.completed" });
    await done1;

    const ctx2 = {
      messages: [
        userMsg("Run ls"),
        buildAssistantMessageFromResponse(turn1Response, modelStub),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      systemPrompt: "You are helpful.",
      tools: [],
    };

    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx2 as Parameters<typeof streamFn>[1],
    );
    const done2 = (async () => {
      for await (const _ of await resolveStream(stream2)) {
        /* Consume */
      }
    })();

    await new Promise((r) => setImmediate(r));
    manager.simulateEvent({
      response: makeResponseObject("resp_turn2", "Done"),
      type: "response.completed",
    });
    await done2;

    const sent2 = manager.sentEvents[1] as {
      previous_response_id?: string;
      input: { type: string; id?: string; call_id?: string }[];
    };
    expect(sent2.previous_response_id).toBeUndefined();
    expect(sent2.input.map((item) => item.type)).toEqual(["message", "reasoning", "function_call"]);
    expect(sent2.input[1]).toMatchObject({ id: "rs_turn1", type: "reasoning" });
    expect(sent2.input[2]).toMatchObject({
      call_id: "call_turn1",
      id: "fc_turn1",
      type: "function_call",
    });
  });

  it("sends instructions (system prompt) in each request", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-tools");
    const ctx = {
      messages: [userMsg("Hello")] as Parameters<typeof convertMessagesToInputItems>[0],
      systemPrompt: "Be concise.",
      tools: [{ description: "run", name: "exec", parameters: {} }],
    };

    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      response: makeResponseObject("resp_x", "ok"),
      type: "response.completed",
    });

    for await (const _ of await resolveStream(stream)) {
      // Consume
    }

    const sent = manager.sentEvents[0] as {
      instructions?: string;
      tools?: unknown[];
    };
    expect(sent.instructions).toBe("Be concise.");
    expect(Array.isArray(sent.tools)).toBe(true);
    expect((sent.tools ?? []).length).toBeGreaterThan(0);
  });

  it("strips the internal cache boundary from websocket instructions", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-boundary");
    const ctx = {
      messages: [userMsg("Hello")] as Parameters<typeof convertMessagesToInputItems>[0],
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
      tools: [],
    };

    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      response: makeResponseObject("resp_boundary", "ok"),
      type: "response.completed",
    });

    for await (const _ of await resolveStream(stream)) {
      // Consume
    }

    const sent = manager.sentEvents[0] as {
      instructions?: string;
    };
    expect(sent.instructions).toBe("Stable prefix\nDynamic suffix");
  });

  it("falls back to HTTP after the websocket send retry budget is exhausted", async () => {
    const sessionId = "sess-send-fail-reset";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    // 1. Run a successful first turn to populate the registry
    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-ok", "OK"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream1)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    expect(hasWsSession(sessionId)).toBe(true);

    // 2. Exhaust both websocket send attempts so auto mode must fall back.
    MockManager.globalSendFailuresRemaining = 2;
    const callsBefore = streamSimpleCalls.length;

    // 3. Second call: send throws → must fall back to HTTP and clear registry
    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );
    for await (const _ of await resolveStream(stream2)) {
      /* Consume */
    }

    // Registry cleared after retry budget exhaustion + HTTP fallback
    expect(hasWsSession(sessionId)).toBe(false);
    // HTTP fallback invoked
    expect(streamSimpleCalls.length).toBeGreaterThan(callsBefore);
  });

  it("routes websocket HTTP fallback through the configured HTTP fallback builder", async () => {
    const httpFallbackCalls: { model: unknown; context: unknown; options?: unknown }[] = [];
    const httpFallbackStreamFn = vi.fn((model: unknown, context: unknown, options?: unknown) => {
      httpFallbackCalls.push({ context, model, options });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const msg = makeFakeAssistantMessage("boundary-safe fallback");
        stream.push({ message: msg, reason: "stop", type: "done" });
        stream.end();
      });
      return stream;
    });
    mockCreateHttpFallbackStreamFn.mockReturnValue(httpFallbackStreamFn as never);
    const sessionId = "sess-boundary-http-fallback";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-ok", "OK"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream1)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    MockManager.globalSendFailuresRemaining = 2;
    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      {
        ...contextStub,
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
      } as Parameters<typeof streamFn>[1],
    );
    for await (const _ of await resolveStream(stream2)) {
      /* Consume */
    }

    expect(mockCreateHttpFallbackStreamFn).toHaveBeenCalled();
    expect(streamSimpleCalls).toHaveLength(0);
    expect(httpFallbackCalls).toHaveLength(1);
    expect(httpFallbackCalls[0]?.context).toMatchObject({
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
    });
  });

  it("forwards temperature and maxTokens to response.create", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-temp");
    const opts = { maxTokens: 256, temperature: 0.3 };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-temp", "Done"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.temperature).toBe(0.3);
    expect(sent.max_output_tokens).toBe(256);
  });

  it("forwards maxTokens: 0 to response.create as max_output_tokens", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-max-tokens-zero");
    const opts = { maxTokens: 0 };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-max-zero", "Done"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.max_output_tokens).toBe(0);
  });

  it("forwards text verbosity to response.create text block", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-text-verbosity");
    const opts = { textVerbosity: "low" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-text-verbosity", "Done"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.text).toEqual({ verbosity: "low" });
  });

  it("warns and skips invalid text verbosity in the websocket path", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-text-verbosity-invalid");
      const opts = { textVerbosity: "loud" };
      const stream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
        opts as unknown as Parameters<typeof streamFn>[2],
      );
      await new Promise<void>((resolve, reject) => {
        queueMicrotask(async () => {
          try {
            await new Promise((r) => setImmediate(r));
            MockManager.lastInstance!.simulateEvent({
              response: makeResponseObject("resp-text-verbosity-invalid", "Done"),
              type: "response.completed",
            });
            for await (const _ of await resolveStream(stream)) {
              /* Consume */
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
      expect(sent.type).toBe("response.create");
      expect(sent).not.toHaveProperty("text");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid OpenAI text verbosity param: loud");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("forwards reasoningEffort/reasoningSummary to response.create reasoning block", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-reason");
    const opts = { reasoningEffort: "high", reasoningSummary: "auto" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-reason", "Deep thought"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("defaults response.create reasoning effort to high for reasoning models", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-reason-default");
    const stream = streamFn(
      { ...modelStub, reasoning: true } as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      undefined,
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-reason-default", "Default thought"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "high" });
  });

  it("forwards shared reasoning to response.create reasoning effort", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-reason-shared");
    const opts = { reasoning: "medium" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-reason-shared", "Shared thought"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "medium" });
  });

  it("omits response.create reasoning when reasoningEffort is none", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-reason-none");
    const opts = { reasoningEffort: "none" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-reason-none", "Short answer"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent).not.toHaveProperty("reasoning");
  });

  it("applies onPayload mutations before sending response.create", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-onpayload");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      {
        onPayload: (payload: unknown) => {
          const request = payload as Record<string, unknown>;
          request.reasoning = { effort: "none" };
          request.text = { verbosity: "low" };
          request.service_tier = "priority";
          return undefined;
        },
      } as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-onpayload", "Done"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "none" });
    expect(sent.text).toEqual({ verbosity: "low" });
    expect(sent.service_tier).toBe("priority");
  });

  it("awaits async onPayload mutations before sending response.create", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-onpayload-async");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      {
        onPayload: async (payload: unknown) => {
          const request = payload as Record<string, unknown>;
          await Promise.resolve();
          request.metadata = { async_hook: "applied" };
          return undefined;
        },
      } as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-onpayload-async", "Done"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.metadata).toMatchObject({ async_hook: "applied" });
  });
  it("forwards topP and toolChoice to response.create", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-topp");
    const opts = { toolChoice: "auto", topP: 0.9 };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-topp", "Done"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            /* Consume */
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.top_p).toBe(0.9);
    expect(sent.tool_choice).toBe("auto");
  });

  it("keeps explicit websocket mode surfacing mid-request drops", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-drop");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "websocket" } as Parameters<typeof streamFn>[2],
    );
    // Let the send go through, then simulate connection drop before response.completed
    await new Promise<void>((resolve) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          // Simulate a connection drop instead of sending response.completed
          MockManager.lastInstance!.simulateClose(1006, "connection lost");
          const events: unknown[] = [];
          for await (const ev of await resolveStream(stream)) {
            events.push(ev);
          }
          // Should have gotten an error event, not hung forever
          const hasError = events.some(
            (e) => typeof e === "object" && e !== null && (e as { type: string }).type === "error",
          );
          expect(hasError).toBe(true);
          resolve();
        } catch {
          // The error propagation is also acceptable — promise rejected
          resolve();
        }
      });
    });
  });

  it("sends warm-up event before first request when openaiWsWarmup=true", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-warmup-enabled");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { openaiWsWarmup: true } as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-warm", "Done"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            // Consume
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents as Record<string, unknown>[];
    expect(sent).toHaveLength(2);
    expect(sent[0]?.type).toBe("response.create");
    expect(sent[0]?.generate).toBe(false);
    expect(sent[1]?.type).toBe("response.create");
  });

  it("skips warm-up when openaiWsWarmup=false", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-warmup-disabled");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { openaiWsWarmup: false } as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            response: makeResponseObject("resp-nowarm", "Done"),
            type: "response.completed",
          });
          for await (const _ of await resolveStream(stream)) {
            // Consume
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents as Record<string, unknown>[];
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("response.create");
    expect(sent[0]?.generate).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("releaseWsSession / hasWsSession", () => {
  beforeEach(() => {
    MockManager.reset();
    openAIWsStreamTesting.setDepsForTest({
      createHttpFallbackStreamFn: mockCreateHttpFallbackStreamFn as never,
      createManager: (() => new MockManager()) as never,
      streamSimple: mockStreamSimple,
    });
  });

  afterEach(() => {
    releaseWsSession("registry-test");
    openAIWsStreamTesting.setDepsForTest();
  });

  it("hasWsSession returns false for unknown session", () => {
    expect(hasWsSession("nonexistent-session")).toBe(false);
  });

  it("hasWsSession returns true after a session is created", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "registry-test");
    const stream = streamFn(
      {
        api: "openai-responses",
        contextWindow: 128_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-5.4",
        input: ["text"],
        maxTokens: 4096,
        name: "GPT-5.2",
        provider: "openai",
        reasoning: false,
      } as Parameters<typeof streamFn>[0],
      {
        messages: [userMsg("Hi") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        systemPrompt: "test",
        tools: [],
      } as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    // Session should be registered and connected
    expect(hasWsSession("registry-test")).toBe(true);

    // Clean up
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      response: makeResponseObject("resp_z", "done"),
      type: "response.completed",
    });
    for await (const _ of await resolveStream(stream)) {
      // Consume
    }
  });

  it("releaseWsSession closes the connection and removes the session", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "registry-test");
    const stream = streamFn(
      {
        api: "openai-responses",
        contextWindow: 128_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-5.4",
        input: ["text"],
        maxTokens: 4096,
        name: "GPT-5.2",
        provider: "openai",
        reasoning: false,
      } as Parameters<typeof streamFn>[0],
      {
        messages: [userMsg("Hi") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        systemPrompt: "test",
        tools: [],
      } as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      response: makeResponseObject("resp_zz", "done"),
      type: "response.completed",
    });
    for await (const _ of await resolveStream(stream)) {
      // Consume
    }

    releaseWsSession("registry-test");
    expect(hasWsSession("registry-test")).toBe(false);
    expect(manager.closeCallCount).toBe(1);
  });

  it("releaseWsSession is a no-op for unknown sessions", () => {
    expect(() => releaseWsSession("nonexistent-session")).not.toThrow();
  });

  it("recreates the cached manager when request overrides change for the same session", async () => {
    const sessionId = "registry-test";
    const firstStreamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId, {
      managerOptions: {
        request: {
          headers: { "x-test": "one" },
        },
      },
    });
    const firstStream = firstStreamFn(
      {
        api: "openai-responses",
        contextWindow: 128_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-5.4",
        input: ["text"],
        maxTokens: 4096,
        name: "GPT-5.4",
        provider: "openai",
        reasoning: false,
      } as Parameters<typeof firstStreamFn>[0],
      {
        messages: [userMsg("Hi") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        systemPrompt: "test",
        tools: [],
      } as Parameters<typeof firstStreamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const firstManager = MockManager.lastInstance!;
    firstManager.simulateEvent({
      response: makeResponseObject("resp-first", "done"),
      type: "response.completed",
    });
    for await (const _ of await resolveStream(firstStream)) {
      // Consume
    }

    const secondStreamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId, {
      managerOptions: {
        request: {
          allowPrivateNetwork: true,
          headers: { "x-test": "two" },
        },
      },
    });
    const secondStream = secondStreamFn(
      {
        api: "openai-responses",
        contextWindow: 128_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-5.4",
        input: ["text"],
        maxTokens: 4096,
        name: "GPT-5.4",
        provider: "openai",
        reasoning: false,
      } as Parameters<typeof secondStreamFn>[0],
      {
        messages: [userMsg("Again") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        systemPrompt: "test",
        tools: [],
      } as Parameters<typeof secondStreamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    expect(MockManager.instances).toHaveLength(2);
    expect(firstManager.closeCallCount).toBe(1);
    const secondManager = MockManager.lastInstance!;
    expect(secondManager).not.toBe(firstManager);
    expect(secondManager.connectCallCount).toBe(1);

    secondManager.simulateEvent({
      response: makeResponseObject("resp-second", "done"),
      type: "response.completed",
    });
    for await (const _ of await resolveStream(secondStream)) {
      // Consume
    }
  });
});

describe("convertMessagesToInputItems — phase inheritance", () => {
  it("keeps unsigned legacy text unphased while id-only replay text inherits message phase", () => {
    const msg = {
      content: [
        { text: "Untagged block A", type: "text" },
        {
          text: "Replay block",
          textSignature: JSON.stringify({ v: 1, id: "s0" }),
          type: "text",
        },
        {
          text: "Explicitly final",
          textSignature: JSON.stringify({ v: 1, id: "s1", phase: "final_answer" }),
          type: "text",
        },
        { text: "Untagged block B", type: "text" },
      ],
      phase: "commentary",
      role: "assistant" as const,
    };
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    const assistantItems = items.filter((i: Record<string, unknown>) => i.role === "assistant");
    expect(assistantItems).toHaveLength(4);
    expect(assistantItems[0]).toMatchObject({
      content: "Untagged block A",
      role: "assistant",
    });
    expect((assistantItems[0] as Record<string, unknown>).phase).toBeUndefined();
    expect(assistantItems[1]).toMatchObject({
      content: "Replay block",
      phase: "commentary",
      role: "assistant",
    });
    expect(assistantItems[2]).toMatchObject({
      content: "Explicitly final",
      phase: "final_answer",
      role: "assistant",
    });
    expect(assistantItems[3]).toMatchObject({
      content: "Untagged block B",
      role: "assistant",
    });
    expect((assistantItems[3] as Record<string, unknown>).phase).toBeUndefined();
  });
});
