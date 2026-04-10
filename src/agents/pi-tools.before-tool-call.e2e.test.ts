import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DiagnosticToolLoopEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import { CRITICAL_THRESHOLD, GLOBAL_CIRCUIT_BREAKER_THRESHOLD } from "./tool-loop-detection.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(),
  };
});
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

describe("before_tool_call loop detection behavior", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };
  const enabledLoopDetectionContext = {
    agentId: "main",
    loopDetection: { enabled: true },
    sessionKey: "main",
  };

  const disabledLoopDetectionContext = {
    agentId: "main",
    loopDetection: { enabled: false },
    sessionKey: "main",
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = {
      hasHooks: vi.fn(),
      runBeforeToolCall: vi.fn(),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
    hookRunner.hasHooks.mockReturnValue(false);
  });

  function createWrappedTool(
    name: string,
    execute: ReturnType<typeof vi.fn>,
    loopDetectionContext = enabledLoopDetectionContext,
  ) {
    return wrapToolWithBeforeToolCallHook(
      { execute, name } as unknown as AnyAgentTool,
      loopDetectionContext,
    );
  }

  async function withToolLoopEvents(
    run: (emitted: DiagnosticToolLoopEvent[]) => Promise<void>,
    filter: (evt: DiagnosticToolLoopEvent) => boolean = () => true,
  ) {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop" && filter(evt)) {
        emitted.push(evt);
      }
    });
    try {
      await run(emitted);
    } finally {
      stop();
    }
  }

  function createPingPongTools(options?: { withProgress?: boolean }) {
    const readExecute = options?.withProgress
      ? vi.fn().mockImplementation(async (toolCallId: string) => ({
          content: [{ text: `read ${toolCallId}`, type: "text" }],
          details: { ok: true },
        }))
      : vi.fn().mockResolvedValue({
          content: [{ text: "read ok", type: "text" }],
          details: { ok: true },
        });
    const listExecute = options?.withProgress
      ? vi.fn().mockImplementation(async (toolCallId: string) => ({
          content: [{ text: `list ${toolCallId}`, type: "text" }],
          details: { ok: true },
        }))
      : vi.fn().mockResolvedValue({
          content: [{ text: "list ok", type: "text" }],
          details: { ok: true },
        });
    return {
      listTool: createWrappedTool("list", listExecute),
      readTool: createWrappedTool("read", readExecute),
    };
  }

  async function runPingPongSequence(
    readTool: ReturnType<typeof createWrappedTool>,
    listTool: ReturnType<typeof createWrappedTool>,
    count: number,
  ) {
    for (let i = 0; i < count; i += 1) {
      if (i % 2 === 0) {
        await readTool.execute(`read-${i}`, { path: "/a.txt" }, undefined, undefined);
      } else {
        await listTool.execute(`list-${i}`, { dir: "/workspace" }, undefined, undefined);
      }
    }
  }

  function createGenericReadRepeatFixture() {
    const execute = vi.fn().mockResolvedValue({
      content: [{ text: "same output", type: "text" }],
      details: { ok: true },
    });
    return {
      params: { path: "/tmp/file" },
      tool: createWrappedTool("read", execute),
    };
  }

  function createNoProgressProcessFixture(sessionId: string) {
    const execute = vi.fn().mockResolvedValue({
      content: [{ text: "(no new output)\n\nProcess still running.", type: "text" }],
      details: { aggregated: "steady", status: "running" },
    });
    return {
      params: { action: "poll", sessionId },
      tool: createWrappedTool("process", execute),
    };
  }

  function expectCriticalLoopEvent(
    loopEvent: DiagnosticToolLoopEvent | undefined,
    params: {
      detector: "ping_pong" | "known_poll_no_progress";
      toolName: string;
      count?: number;
    },
  ) {
    expect(loopEvent?.type).toBe("tool.loop");
    expect(loopEvent?.level).toBe("critical");
    expect(loopEvent?.action).toBe("block");
    expect(loopEvent?.detector).toBe(params.detector);
    expect(loopEvent?.count).toBe(params.count ?? CRITICAL_THRESHOLD);
    expect(loopEvent?.toolName).toBe(params.toolName);
  }

  it("blocks known poll loops when no progress repeats", async () => {
    const { tool, params } = createNoProgressProcessFixture("sess-1");

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expect(tool.execute(`poll-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }

    await expect(
      tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined),
    ).rejects.toThrow("CRITICAL");
  });

  it("does nothing when loopDetection.enabled is false", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ text: "(no new output)\n\nProcess still running.", type: "text" }],
      details: { aggregated: "steady", status: "running" },
    });
    const tool = wrapToolWithBeforeToolCallHook({ execute, name: "process" } as any, {
      ...disabledLoopDetectionContext,
    });
    const params = { action: "poll", sessionId: "sess-off" };

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expect(tool.execute(`poll-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }
  });

  it("does not block known poll loops when output progresses", async () => {
    const execute = vi.fn().mockImplementation(async (toolCallId: string) => ({
      content: [{ text: `output ${toolCallId}`, type: "text" }],
      details: { aggregated: `output ${toolCallId}`, status: "running" },
    }));
    const tool = createWrappedTool("process", execute);
    const params = { action: "poll", sessionId: "sess-2" };

    for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
      await expect(
        tool.execute(`poll-progress-${i}`, params, undefined, undefined),
      ).resolves.toBeDefined();
    }
  });

  it("keeps generic repeated calls warn-only below global breaker", async () => {
    const { tool, params } = createGenericReadRepeatFixture();

    for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
      await expect(tool.execute(`read-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }
  });

  it("blocks generic repeated no-progress calls at global breaker threshold", async () => {
    const { tool, params } = createGenericReadRepeatFixture();

    for (let i = 0; i < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; i += 1) {
      await expect(tool.execute(`read-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }

    await expect(
      tool.execute(`read-${GLOBAL_CIRCUIT_BREAKER_THRESHOLD}`, params, undefined, undefined),
    ).rejects.toThrow("global circuit breaker");
  });

  it("coalesces repeated generic warning events into threshold buckets", async () => {
    await withToolLoopEvents(
      async (emitted) => {
        const { tool, params } = createGenericReadRepeatFixture();

        for (let i = 0; i < 21; i += 1) {
          await tool.execute(`read-bucket-${i}`, params, undefined, undefined);
        }

        const genericWarns = emitted.filter((evt) => evt.detector === "generic_repeat");
        expect(genericWarns.map((evt) => evt.count)).toEqual([10, 20]);
      },
      (evt) => evt.level === "warning",
    );
  });

  it("emits structured warning diagnostic events for ping-pong loops", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools();
      await runPingPongSequence(readTool, listTool, 9);

      await listTool.execute("list-9", { dir: "/workspace" }, undefined, undefined);
      await readTool.execute("read-10", { path: "/a.txt" }, undefined, undefined);
      await listTool.execute("list-11", { dir: "/workspace" }, undefined, undefined);

      const pingPongWarns = emitted.filter(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expect(pingPongWarns).toHaveLength(1);
      const loopEvent = pingPongWarns[0];
      expect(loopEvent?.type).toBe("tool.loop");
      expect(loopEvent?.level).toBe("warning");
      expect(loopEvent?.action).toBe("warn");
      expect(loopEvent?.detector).toBe("ping_pong");
      expect(loopEvent?.count).toBe(10);
      expect(loopEvent?.toolName).toBe("list");
    });
  });

  it("blocks ping-pong loops at critical threshold and emits critical diagnostic events", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools();
      await runPingPongSequence(readTool, listTool, CRITICAL_THRESHOLD - 1);

      await expect(
        listTool.execute(
          `list-${CRITICAL_THRESHOLD - 1}`,
          { dir: "/workspace" },
          undefined,
          undefined,
        ),
      ).rejects.toThrow("CRITICAL");

      const loopEvent = emitted.at(-1);
      expectCriticalLoopEvent(loopEvent, {
        detector: "ping_pong",
        toolName: "list",
      });
    });
  });

  it("does not block ping-pong at critical threshold when outcomes are progressing", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools({ withProgress: true });
      await runPingPongSequence(readTool, listTool, CRITICAL_THRESHOLD - 1);

      await expect(
        listTool.execute(
          `list-${CRITICAL_THRESHOLD - 1}`,
          { dir: "/workspace" },
          undefined,
          undefined,
        ),
      ).resolves.toBeDefined();

      const criticalPingPong = emitted.find(
        (evt) => evt.level === "critical" && evt.detector === "ping_pong",
      );
      expect(criticalPingPong).toBeUndefined();
      const warningPingPong = emitted.find(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expect(warningPingPong).toBeTruthy();
    });
  });

  it("emits structured critical diagnostic events when blocking loops", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { tool, params } = createNoProgressProcessFixture("sess-crit");

      for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
        await tool.execute(`poll-${i}`, params, undefined, undefined);
      }

      await expect(
        tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined),
      ).rejects.toThrow("CRITICAL");

      const loopEvent = emitted.at(-1);
      expectCriticalLoopEvent(loopEvent, {
        detector: "known_poll_no_progress",
        toolName: "process",
      });
    });
  });
});

describe("before_tool_call requireApproval handling", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };
  const mockCallGateway = vi.mocked(callGatewayTool);

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn(),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
    // Keep the global singleton aligned as a fallback in case another setup path
    // Preloads hook-runner-global before this test's module reset/mocks take effect.
    const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");
    const hookRunnerGlobalState = globalThis as Record<
      symbol,
      { hookRunner: unknown; registry?: unknown } | undefined
    >;
    if (!hookRunnerGlobalState[hookRunnerGlobalStateKey]) {
      hookRunnerGlobalState[hookRunnerGlobalStateKey] = {
        hookRunner: null,
        registry: null,
      };
    }
    hookRunnerGlobalState[hookRunnerGlobalStateKey].hookRunner = hookRunner;
    mockCallGateway.mockReset();
  });

  it("blocks without triggering approval when both block and requireApproval are set", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "Blocked by security plugin",
      requireApproval: {
        description: "This approval should be skipped",
        pluginId: "lower-priority-plugin",
        title: "Should not reach gateway",
      },
    });

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: { command: "rm -rf" },
      toolName: "bash",
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Blocked by security plugin");
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it("blocks when before_tool_call hook execution throws", async () => {
    hookRunner.runBeforeToolCall.mockRejectedValueOnce(new Error("hook crashed"));

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: { command: "ls" },
      toolName: "bash",
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty(
      "reason",
      "Tool call blocked because before_tool_call hook failed",
    );
  });

  it("calls gateway RPC and unblocks on allow-once", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Sensitive op",
        pluginId: "sage",
        title: "Sensitive",
      },
    });

    // First call: plugin.approval.request → returns server-generated id
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-1", status: "accepted" });
    // Second call: plugin.approval.waitDecision → returns allow-once
    mockCallGateway.mockResolvedValueOnce({ decision: "allow-once", id: "server-id-1" });

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: { command: "rm -rf" },
      toolName: "bash",
    });

    expect(result.blocked).toBe(false);
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
    expect(mockCallGateway).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({ twoPhase: true }),
      { expectFinal: false },
    );
    expect(mockCallGateway).toHaveBeenCalledWith(
      "plugin.approval.waitDecision",
      expect.any(Object),
      { id: "server-id-1" },
    );
  });

  it("blocks on deny decision", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Dangerous op",
        title: "Dangerous",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-2", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ decision: "deny", id: "server-id-2" });

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      toolName: "bash",
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Denied by user");
  });

  it("blocks on timeout with default deny behavior", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Will time out",
        title: "Timeout test",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-3", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ decision: null, id: "server-id-3" });

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      toolName: "bash",
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval timed out");
  });

  it("allows on timeout when timeoutBehavior is allow and preserves hook params", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      params: { command: "safe-command" },
      requireApproval: {
        description: "Should allow on timeout",
        timeoutBehavior: "allow",
        title: "Lenient timeout",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-4", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ decision: null, id: "server-id-4" });

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: { command: "rm -rf /" },
      toolName: "bash",
    });

    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.params).toEqual({ command: "safe-command" });
    }
  });

  it("falls back to block on gateway error", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Gateway is unavailable",
        title: "Gateway down",
      },
    });

    mockCallGateway.mockRejectedValueOnce(new Error("unknown method plugin.approval.request"));

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      toolName: "bash",
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval required (gateway unavailable)");
  });

  it("blocks when gateway returns no id", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Registration returns no id",
        title: "No ID",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ status: "error" });

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      toolName: "bash",
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Registration returns no id");
  });

  it("blocks on immediate null decision without calling waitDecision even when timeoutBehavior is allow", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "No approval route available",
        onResolution,
        timeoutBehavior: "allow",
        title: "No route",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ decision: null, id: "server-id-immediate" });

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      toolName: "bash",
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval unavailable (no approval route)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
    expect(mockCallGateway.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
    ]);
  });

  it("unblocks immediately when abort signal fires during waitDecision", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Will be aborted",
        title: "Abortable",
      },
    });

    const controller = new AbortController();

    // First call: plugin.approval.request → accepted
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-abort", status: "accepted" });
    // Second call: plugin.approval.waitDecision → never resolves (simulates long wait)
    mockCallGateway.mockImplementationOnce(
      () => new Promise(() => {}), // Hangs forever
    );

    // Abort after a short delay
    setTimeout(() => controller.abort(new Error("run cancelled")), 10);

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      signal: controller.signal,
      toolName: "bash",
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
  });

  it("removes abort listener after waitDecision resolves", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Wait resolves quickly",
        title: "Cleanup listener",
      },
    });

    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener");

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-cleanup", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ decision: "allow-once", id: "server-id-cleanup" });

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      signal: controller.signal,
      toolName: "bash",
    });

    expect(result.blocked).toBe(false);
    expect(removeListenerSpy.mock.calls.some(([type]) => type === "abort")).toBe(true);
  });

  it("calls onResolution with allow-once on approval", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Check this",
        onResolution,
        title: "Needs approval",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ decision: "allow-once", id: "server-id-r1" });

    await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      toolName: "bash",
    });

    expect(onResolution).toHaveBeenCalledWith("allow-once");
  });

  it("does not await onResolution before returning approval outcome", async () => {
    const onResolution = vi.fn(() => new Promise<void>(() => {}));

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Should not block tool execution",
        onResolution,
        title: "Non-blocking callback",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1-nonblocking", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      decision: "allow-once",
      id: "server-id-r1-nonblocking",
    });

    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        runBeforeToolCallHook({
          ctx: { agentId: "main", sessionKey: "main" },
          params: {},
          toolName: "bash",
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("runBeforeToolCallHook waited for onResolution")),
            250,
          );
        }),
      ]);

      expect(result).toEqual({ blocked: false, params: {} });
      expect(onResolution).toHaveBeenCalledWith("allow-once");
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  });

  it("calls onResolution with deny on denial", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Check this",
        onResolution,
        title: "Needs approval",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r2", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ decision: "deny", id: "server-id-r2" });

    await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      toolName: "bash",
    });

    expect(onResolution).toHaveBeenCalledWith("deny");
  });

  it("calls onResolution with timeout when decision is null", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Will time out",
        onResolution,
        title: "Timeout resolution",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r3", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ decision: null, id: "server-id-r3" });

    await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      toolName: "bash",
    });

    expect(onResolution).toHaveBeenCalledWith("timeout");
  });

  it("calls onResolution with cancelled on gateway error", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Gateway will fail",
        onResolution,
        title: "Gateway error",
      },
    });

    mockCallGateway.mockRejectedValueOnce(new Error("gateway down"));

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      toolName: "bash",
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval required (gateway unavailable)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("calls onResolution with cancelled when abort signal fires", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Will be aborted",
        onResolution,
        title: "Abortable with callback",
      },
    });

    const controller = new AbortController();

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r5", status: "accepted" });
    mockCallGateway.mockImplementationOnce(
      () => new Promise(() => {}), // Hangs forever
    );

    setTimeout(() => controller.abort(new Error("run cancelled")), 10);

    const result = await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      signal: controller.signal,
      toolName: "bash",
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("calls onResolution with cancelled when gateway returns no id", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        description: "Registration returns no id",
        onResolution,
        title: "No ID",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ status: "error" });

    await runBeforeToolCallHook({
      ctx: { agentId: "main", sessionKey: "main" },
      params: {},
      toolName: "bash",
    });

    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });
});
