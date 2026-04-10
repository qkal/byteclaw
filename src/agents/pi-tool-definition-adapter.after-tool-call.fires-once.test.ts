/**
 * Integration test: after_tool_call fires exactly once when both the adapter
 * (toToolDefinitions) and the subscription handler (handleToolExecutionEnd)
 * are active — the production scenario for embedded runs.
 *
 * Regression guard for the double-fire bug fixed by removing the adapter-side
 * after_tool_call invocation (see PR #27283 → dedup in this fix).
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseToolHandlerState } from "./pi-tool-handler-state.test-helpers.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => true),
    runAfterToolCall: vi.fn(async () => {}),
    runBeforeToolCall: vi.fn(async () => {}),
  },
}));

const beforeToolCallMocks = vi.hoisted(() => ({
  consumeAdjustedParamsForToolCall: vi.fn((_: string): unknown => undefined),
  isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

function createTestTool(name: string) {
  return {
    description: `test tool: ${name}`,
    execute: vi.fn(async () => ({
      content: [{ text: "ok", type: "text" as const }],
      details: { ok: true },
    })),
    label: name,
    name,
    parameters: Type.Object({}),
  } satisfies AgentTool;
}

function createFailingTool(name: string) {
  return {
    description: `failing tool: ${name}`,
    execute: vi.fn(async () => {
      throw new Error("tool failed");
    }),
    label: name,
    name,
    parameters: Type.Object({}),
  } satisfies AgentTool;
}

function createToolHandlerCtx() {
  return {
    emitToolOutput: vi.fn(),
    emitToolSummary: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: hookMocks.runner,
    log: { debug: vi.fn(), warn: vi.fn() },
    params: {
      runId: "integration-test",
      session: { messages: [] },
    },
    shouldEmitToolOutput: () => false,
    shouldEmitToolResult: () => false,
    state: {
      ...createBaseToolHandlerState(),
      successfulCronAdds: 0,
    },
    trimMessagingToolSent: vi.fn(),
  };
}

let toToolDefinitions: typeof import("./pi-tool-definition-adapter.js").toToolDefinitions;
let handleToolExecutionStart: typeof import("./pi-embedded-subscribe.handlers.tools.js").handleToolExecutionStart;
let handleToolExecutionEnd: typeof import("./pi-embedded-subscribe.handlers.tools.js").handleToolExecutionEnd;

async function loadFreshAfterToolCallModulesForTest() {
  vi.doMock("../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: () => hookMocks.runner,
  }));
  vi.doMock("../infra/agent-events.js", () => ({
    emitAgentCommandOutputEvent: vi.fn(),
    emitAgentEvent: vi.fn(),
    emitAgentItemEvent: vi.fn(),
  }));
  vi.doMock("./pi-tools.before-tool-call.js", () => ({
    consumeAdjustedParamsForToolCall: beforeToolCallMocks.consumeAdjustedParamsForToolCall,
    isToolWrappedWithBeforeToolCallHook: beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook,
    runBeforeToolCallHook: beforeToolCallMocks.runBeforeToolCallHook,
  }));
  ({ toToolDefinitions } = await import("./pi-tool-definition-adapter.js"));
  ({ handleToolExecutionStart, handleToolExecutionEnd } =
    await import("./pi-embedded-subscribe.handlers.tools.js"));
}

describe("after_tool_call fires exactly once in embedded runs", () => {
  beforeAll(loadFreshAfterToolCallModulesForTest);

  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runAfterToolCall.mockClear();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    hookMocks.runner.runBeforeToolCall.mockClear();
    hookMocks.runner.runBeforeToolCall.mockResolvedValue(undefined);
    beforeToolCallMocks.consumeAdjustedParamsForToolCall.mockClear();
    beforeToolCallMocks.consumeAdjustedParamsForToolCall.mockReturnValue(undefined);
    beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook.mockClear();
    beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(false);
    beforeToolCallMocks.runBeforeToolCallHook.mockClear();
    beforeToolCallMocks.runBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  function resolveAdapterDefinition(tool: Parameters<typeof toToolDefinitions>[0][number]) {
    const def = toToolDefinitions([tool])[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    const extensionContext = {} as Parameters<typeof def.execute>[4];
    return { def, extensionContext };
  }

  async function emitToolExecutionStartEvent(params: {
    ctx: ReturnType<typeof createToolHandlerCtx>;
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
  }) {
    await handleToolExecutionStart(
      params.ctx as never,
      {
        args: params.args,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        type: "tool_execution_start",
      } as never,
    );
  }

  async function emitToolExecutionEndEvent(params: {
    ctx: ReturnType<typeof createToolHandlerCtx>;
    toolName: string;
    toolCallId: string;
    isError: boolean;
    result: unknown;
  }) {
    await handleToolExecutionEnd(
      params.ctx as never,
      {
        isError: params.isError,
        result: params.result,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        type: "tool_execution_end",
      } as never,
    );
  }

  it("fires after_tool_call exactly once on success when both adapter and handler are active", async () => {
    const { def, extensionContext } = resolveAdapterDefinition(createTestTool("read"));

    const toolCallId = "integration-call-1";
    const args = { path: "/tmp/test.txt" };
    const ctx = createToolHandlerCtx();

    // Step 1: Simulate tool_execution_start event (SDK emits this)
    await emitToolExecutionStartEvent({ args, ctx, toolCallId, toolName: "read" });

    // Step 2: Execute tool through the adapter wrapper (SDK calls this)
    await def.execute(toolCallId, args, undefined, undefined, extensionContext);

    // Step 3: Simulate tool_execution_end event (SDK emits this after execute returns)
    await emitToolExecutionEndEvent({
      ctx,
      isError: false,
      result: { content: [{ text: "ok", type: "text" }] },
      toolCallId,
      toolName: "read",
    });

    // The hook must fire exactly once — not zero, not two.
    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
  });

  it("fires after_tool_call exactly once on error when both adapter and handler are active", async () => {
    const { def, extensionContext } = resolveAdapterDefinition(createFailingTool("exec"));

    const toolCallId = "integration-call-err";
    const args = { command: "fail" };
    const ctx = createToolHandlerCtx();

    await emitToolExecutionStartEvent({ args, ctx, toolCallId, toolName: "exec" });

    await def.execute(toolCallId, args, undefined, undefined, extensionContext);

    await emitToolExecutionEndEvent({
      ctx,
      isError: true,
      result: { error: "tool failed", status: "error" },
      toolCallId,
      toolName: "exec",
    });

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);

    const call = (hookMocks.runner.runAfterToolCall as ReturnType<typeof vi.fn>).mock.calls[0];
    const event = call?.[0] as { error?: unknown } | undefined;
    expect(event?.error).toBeDefined();
  });

  it("uses before_tool_call adjusted params for after_tool_call payload", async () => {
    const { def, extensionContext } = resolveAdapterDefinition(createTestTool("read"));

    const toolCallId = "integration-call-adjusted";
    const args = { path: "/tmp/original.txt" };
    const adjusted = { mode: "safe", path: "/tmp/adjusted.txt" };
    const ctx = createToolHandlerCtx();

    beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(true);
    beforeToolCallMocks.consumeAdjustedParamsForToolCall.mockImplementation((id: string) =>
      id === toolCallId ? adjusted : undefined,
    );

    await emitToolExecutionStartEvent({ args, ctx, toolCallId, toolName: "read" });
    await def.execute(toolCallId, args, undefined, undefined, extensionContext);
    await emitToolExecutionEndEvent({
      ctx,
      isError: false,
      result: { content: [{ text: "ok", type: "text" }] },
      toolCallId,
      toolName: "read",
    });

    expect(beforeToolCallMocks.consumeAdjustedParamsForToolCall).toHaveBeenCalledWith(
      toolCallId,
      "integration-test",
    );
    const event = (hookMocks.runner.runAfterToolCall as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { params?: unknown } | undefined;
    expect(event?.params).toEqual(adjusted);
  });

  it("fires after_tool_call exactly once per tool across multiple sequential tool calls", async () => {
    const { def, extensionContext } = resolveAdapterDefinition(createTestTool("write"));
    const ctx = createToolHandlerCtx();

    for (let i = 0; i < 3; i++) {
      const toolCallId = `sequential-call-${i}`;
      const args = { content: "data", path: `/tmp/file-${i}.txt` };

      await emitToolExecutionStartEvent({ args, ctx, toolCallId, toolName: "write" });

      await def.execute(toolCallId, args, undefined, undefined, extensionContext);

      await emitToolExecutionEndEvent({
        ctx,
        isError: false,
        result: { content: [{ text: "written", type: "text" }] },
        toolCallId,
        toolName: "write",
      });
    }

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(3);
  });
});
