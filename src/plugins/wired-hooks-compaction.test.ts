/**
 * Test: before_compaction & after_compaction hook wiring
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeZeroUsageSnapshot } from "../agents/usage.js";

const hookMocks = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
  runner: {
    hasHooks: vi.fn(() => false),
    runAfterCompaction: vi.fn(async () => {}),
    runBeforeCompaction: vi.fn(async () => {}),
  },
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: hookMocks.emitAgentEvent,
}));

import {
  handleAutoCompactionEnd,
  handleAutoCompactionStart,
} from "../agents/pi-embedded-subscribe.handlers.compaction.js";

describe("compaction hook wiring", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeCompaction.mockClear();
    hookMocks.runner.runBeforeCompaction.mockResolvedValue(undefined);
    hookMocks.runner.runAfterCompaction.mockClear();
    hookMocks.runner.runAfterCompaction.mockResolvedValue(undefined);
    hookMocks.emitAgentEvent.mockClear();
  });

  function createCompactionEndCtx(params: {
    runId: string;
    messages?: unknown[];
    sessionFile?: string;
    sessionKey?: string;
    compactionCount?: number;
    withRetryHooks?: boolean;
  }) {
    return {
      getCompactionCount: () => params.compactionCount ?? 0,
      incrementCompactionCount: vi.fn(),
      log: { debug: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      params: {
        runId: params.runId,
        session: {
          messages: params.messages ?? [],
          sessionFile: params.sessionFile,
        },
        sessionKey: params.sessionKey,
      },
      state: { compactionInFlight: true },
      ...(params.withRetryHooks
        ? {
            noteCompactionRetry: vi.fn(),
            resetForCompactionRetry: vi.fn(),
          }
        : {}),
    };
  }

  function getBeforeCompactionCall() {
    const beforeCalls = hookMocks.runner.runBeforeCompaction.mock.calls as unknown as [
      unknown,
      unknown,
    ][];
    return {
      event: beforeCalls[0]?.[0] as
        | { messageCount?: number; messages?: unknown[]; sessionFile?: string }
        | undefined,
      hookCtx: beforeCalls[0]?.[1] as { sessionKey?: string } | undefined,
    };
  }

  function getAfterCompactionCall() {
    const afterCalls = hookMocks.runner.runAfterCompaction.mock.calls as unknown as [
      unknown,
      unknown,
    ][];
    return {
      event: afterCalls[0]?.[0] as
        | { messageCount?: number; compactedCount?: number; sessionFile?: string }
        | undefined,
      hookCtx: afterCalls[0]?.[1] as { sessionKey?: string } | undefined,
    };
  }

  function expectCompactionEvent(params: {
    call: ReturnType<typeof getBeforeCompactionCall> | ReturnType<typeof getAfterCompactionCall>;
    expectedEvent: Record<string, unknown>;
    expectedSessionKey?: string;
  }) {
    expect(params.call.event).toEqual(expect.objectContaining(params.expectedEvent));
    if (params.expectedSessionKey !== undefined) {
      expect(params.call.hookCtx?.sessionKey).toBe(params.expectedSessionKey);
    }
  }

  function runCompactionEnd(
    ctx: ReturnType<typeof createCompactionEndCtx> | Record<string, unknown>,
    event: {
      willRetry: boolean;
      result?: { summary: string };
      aborted?: boolean;
    },
  ) {
    handleAutoCompactionEnd(
      ctx as never,
      {
        type: "auto_compaction_end",
        ...event,
      } as never,
    );
  }

  it("calls runBeforeCompaction in handleAutoCompactionStart", () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = {
      ensureCompactionPromise: vi.fn(),
      incrementCompactionCount: vi.fn(),
      log: { debug: vi.fn(), warn: vi.fn() },
      params: {
        onAgentEvent: vi.fn(),
        runId: "r1",
        session: { messages: [1, 2, 3], sessionFile: "/tmp/test.jsonl" },
        sessionKey: "agent:main:web-abc123",
      },
      state: { compactionInFlight: false },
    };

    handleAutoCompactionStart(ctx as never);

    expect(hookMocks.runner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expectCompactionEvent({
      call: getBeforeCompactionCall(),
      expectedEvent: {
        messageCount: 3,
        messages: [1, 2, 3],
        sessionFile: "/tmp/test.jsonl",
      },
      expectedSessionKey: "agent:main:web-abc123",
    });
    expect(ctx.ensureCompactionPromise).toHaveBeenCalledTimes(1);
    expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
      data: { phase: "start" },
      runId: "r1",
      stream: "compaction",
    });
    expect(ctx.params.onAgentEvent).toHaveBeenCalledWith({
      data: { phase: "start" },
      stream: "compaction",
    });
  });

  it("calls runAfterCompaction when willRetry is false", () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createCompactionEndCtx({
      compactionCount: 1,
      messages: [1, 2],
      runId: "r2",
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:web-xyz",
    });

    runCompactionEnd(ctx, { result: { summary: "compacted" }, willRetry: false });

    expect(hookMocks.runner.runAfterCompaction).toHaveBeenCalledTimes(1);
    expectCompactionEvent({
      call: getAfterCompactionCall(),
      expectedEvent: {
        compactedCount: 1,
        messageCount: 2,
        sessionFile: "/tmp/session.jsonl",
      },
      expectedSessionKey: "agent:main:web-xyz",
    });
    expect(ctx.incrementCompactionCount).toHaveBeenCalledTimes(1);
    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
      data: { completed: true, phase: "end", willRetry: false },
      runId: "r2",
      stream: "compaction",
    });
  });

  it("does not call runAfterCompaction when willRetry is true but still increments counter", () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createCompactionEndCtx({
      compactionCount: 1,
      runId: "r3",
      withRetryHooks: true,
    });

    runCompactionEnd(ctx, { result: { summary: "compacted" }, willRetry: true });

    expect(hookMocks.runner.runAfterCompaction).not.toHaveBeenCalled();
    // Counter is incremented even with willRetry — compaction succeeded (#38905)
    expect(ctx.incrementCompactionCount).toHaveBeenCalledTimes(1);
    expect(ctx.noteCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.resetForCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.maybeResolveCompactionWait).not.toHaveBeenCalled();
    expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
      data: { completed: true, phase: "end", willRetry: true },
      runId: "r3",
      stream: "compaction",
    });
  });

  it.each([
    ["does not increment counter when compaction was aborted", { aborted: true, willRetry: false }],
    [
      "does not increment counter when compaction has result but was aborted",
      { aborted: true, result: { summary: "compacted" }, willRetry: false },
    ],
    ["does not increment counter when result is undefined", { willRetry: false }],
  ] as const)("%s", (_name, event) => {
    const ctx = createCompactionEndCtx({ runId: "r3c" });
    runCompactionEnd(ctx, event);
    expect(ctx.incrementCompactionCount).not.toHaveBeenCalled();
  });

  it("resets stale assistant usage after final compaction", () => {
    const messages = [
      { content: "hello", role: "user" },
      {
        content: "response one",
        role: "assistant",
        usage: { input: 100, output: 50, totalTokens: 180_000 },
      },
      {
        content: "response two",
        role: "assistant",
        usage: { input: 120, output: 60, totalTokens: 181_000 },
      },
    ];

    const ctx = {
      getCompactionCount: () => 1,
      incrementCompactionCount: vi.fn(),
      log: { debug: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      params: { runId: "r4", session: { messages } },
      state: { compactionInFlight: true },
    };

    runCompactionEnd(ctx, { result: { summary: "compacted" }, willRetry: false });

    const assistantOne = messages[1] as { usage?: unknown };
    const assistantTwo = messages[2] as { usage?: unknown };
    expect(assistantOne.usage).toEqual(makeZeroUsageSnapshot());
    expect(assistantTwo.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("does not clear assistant usage while compaction is retrying", () => {
    const messages = [
      {
        content: "response",
        role: "assistant",
        usage: { input: 130_000, output: 2000, totalTokens: 184_297 },
      },
    ];

    const ctx = {
      getCompactionCount: () => 0,
      log: { debug: vi.fn(), warn: vi.fn() },
      noteCompactionRetry: vi.fn(),
      params: { runId: "r5", session: { messages } },
      resetForCompactionRetry: vi.fn(),
      state: { compactionInFlight: true },
    };

    runCompactionEnd(ctx, { willRetry: true });

    const assistant = messages[0] as { usage?: unknown };
    expect(assistant.usage).toEqual({ input: 130_000, output: 2000, totalTokens: 184_297 });
  });
});
