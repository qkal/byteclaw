import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
/**
 * Test: after_tool_call hook wiring (pi-embedded-subscribe.handlers.tools.ts)
 */
import { createBaseToolHandlerState } from "../agents/pi-tool-handler-state.test-helpers.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runAfterToolCall: vi.fn(async () => {}),
    runBeforeToolCall: vi.fn(async () => {}),
  },
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

// Mock agent events (used by handlers)
vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

function createToolHandlerCtx(params: {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  onBlockReplyFlush?: unknown;
}) {
  return {
    emitToolOutput: vi.fn(),
    emitToolSummary: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: hookMocks.runner,
    log: { debug: vi.fn(), warn: vi.fn() },
    params: {
      agentId: params.agentId,
      onBlockReplyFlush: params.onBlockReplyFlush,
      runId: params.runId,
      session: { messages: [] },
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    },
    shouldEmitToolOutput: () => false,
    shouldEmitToolResult: () => false,
    state: {
      ...createBaseToolHandlerState(),
    },
    trimMessagingToolSent: vi.fn(),
  };
}

function getAfterToolCallCall(index = 0) {
  const call = (hookMocks.runner.runAfterToolCall as ReturnType<typeof vi.fn>).mock.calls[index];
  return {
    context: call?.[1] as
      | {
          toolName?: string;
          agentId?: string;
          sessionKey?: string;
          sessionId?: string;
          runId?: string;
          toolCallId?: string;
        }
      | undefined,
    event: call?.[0] as
      | {
          toolName?: string;
          params?: unknown;
          error?: unknown;
          durationMs?: unknown;
          runId?: string;
          toolCallId?: string;
        }
      | undefined,
  };
}

function expectAfterToolCallPayload(params: {
  index?: number;
  expectedEvent: Record<string, unknown>;
  expectedContext: Record<string, unknown>;
}) {
  const { event, context } = getAfterToolCallCall(params.index);
  expect(event).toBeDefined();
  expect(context).toBeDefined();
  if (!event || !context) {
    throw new Error("missing hook call payload");
  }
  expect(event).toEqual(expect.objectContaining(params.expectedEvent));
  expect(context).toEqual(expect.objectContaining(params.expectedContext));
}

let handleToolExecutionStart: typeof import("../agents/pi-embedded-subscribe.handlers.tools.js").handleToolExecutionStart;
let handleToolExecutionEnd: typeof import("../agents/pi-embedded-subscribe.handlers.tools.js").handleToolExecutionEnd;

describe("after_tool_call hook wiring", () => {
  beforeAll(async () => {
    ({ handleToolExecutionStart, handleToolExecutionEnd } =
      await import("../agents/pi-embedded-subscribe.handlers.tools.js"));
  });

  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeToolCall.mockClear();
    hookMocks.runner.runBeforeToolCall.mockResolvedValue(undefined);
    hookMocks.runner.runAfterToolCall.mockClear();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
  });

  it("calls runAfterToolCall in handleToolExecutionEnd when hook is registered", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createToolHandlerCtx({
      agentId: "main",
      runId: "test-run-1",
      sessionId: "test-ephemeral-session",
      sessionKey: "test-session",
    });

    await handleToolExecutionStart(
      ctx as never,
      {
        args: { path: "/tmp/file.txt" },
        toolCallId: "wired-hook-call-1",
        toolName: "read",
        type: "tool_execution_start",
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: { content: [{ text: "file contents", type: "text" }] },
        toolCallId: "wired-hook-call-1",
        toolName: "read",
        type: "tool_execution_end",
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runBeforeToolCall).not.toHaveBeenCalled();
    expectAfterToolCallPayload({
      expectedContext: {
        agentId: "main",
        runId: "test-run-1",
        sessionId: "test-ephemeral-session",
        sessionKey: "test-session",
        toolCallId: "wired-hook-call-1",
        toolName: "read",
      },
      expectedEvent: {
        error: undefined,
        params: { path: "/tmp/file.txt" },
        runId: "test-run-1",
        toolCallId: "wired-hook-call-1",
        toolName: "read",
      },
    });
    expect(typeof getAfterToolCallCall().event?.durationMs).toBe("number");
  });

  it("includes error in after_tool_call event on tool failure", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createToolHandlerCtx({ runId: "test-run-2" });

    await handleToolExecutionStart(
      ctx as never,
      {
        args: { command: "fail" },
        toolCallId: "call-err",
        toolName: "exec",
        type: "tool_execution_start",
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: true,
        result: { error: "command failed", status: "error" },
        toolCallId: "call-err",
        toolName: "exec",
        type: "tool_execution_end",
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    expect(getAfterToolCallCall().event?.error).toBeDefined();
    expect(getAfterToolCallCall().context?.agentId).toBeUndefined();
  });

  it("does not call runAfterToolCall when no hooks registered", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);

    const ctx = createToolHandlerCtx({ runId: "r" });

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: {},
        toolCallId: "call-2",
        toolName: "exec",
        type: "tool_execution_end",
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("keeps start args isolated per run when toolCallId collides", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sharedToolCallId = "shared-tool-call-id";

    const ctxA = createToolHandlerCtx({
      agentId: "agent-a",
      runId: "run-a",
      sessionId: "ephemeral-a",
      sessionKey: "session-a",
    });
    const ctxB = createToolHandlerCtx({
      agentId: "agent-b",
      runId: "run-b",
      sessionId: "ephemeral-b",
      sessionKey: "session-b",
    });

    await handleToolExecutionStart(
      ctxA as never,
      {
        args: { path: "/tmp/path-a.txt" },
        toolCallId: sharedToolCallId,
        toolName: "read",
        type: "tool_execution_start",
      } as never,
    );
    await handleToolExecutionStart(
      ctxB as never,
      {
        args: { path: "/tmp/path-b.txt" },
        toolCallId: sharedToolCallId,
        toolName: "read",
        type: "tool_execution_start",
      } as never,
    );

    await handleToolExecutionEnd(
      ctxA as never,
      {
        isError: false,
        result: { content: [{ text: "done-a", type: "text" }] },
        toolCallId: sharedToolCallId,
        toolName: "read",
        type: "tool_execution_end",
      } as never,
    );
    await handleToolExecutionEnd(
      ctxB as never,
      {
        isError: false,
        result: { content: [{ text: "done-b", type: "text" }] },
        toolCallId: sharedToolCallId,
        toolName: "read",
        type: "tool_execution_end",
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(2);
    expectAfterToolCallPayload({
      expectedContext: {},
      expectedEvent: { params: { path: "/tmp/path-a.txt" }, runId: "run-a" },
      index: 0,
    });
    expectAfterToolCallPayload({
      expectedContext: {},
      expectedEvent: { params: { path: "/tmp/path-b.txt" }, runId: "run-b" },
      index: 1,
    });
  });
});
