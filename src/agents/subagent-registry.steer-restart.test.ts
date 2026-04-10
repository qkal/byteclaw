import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};
let lifecycleHandler:
  | ((evt: {
      stream?: string;
      runId: string;
      data?: {
        phase?: string;
        startedAt?: number;
        endedAt?: number;
        aborted?: boolean;
        error?: string;
      };
    }) => void)
  | undefined;

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent.wait") {
      return { status: "timeout" };
    }
    return {};
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  })),
}));

vi.mock("../config/sessions.js", () => {
  const sessionStore = new Proxy<Record<string, { sessionId: string; updatedAt: number }>>(
    {},
    {
      get(target, prop, receiver) {
        if (typeof prop !== "string" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return { sessionId: `sess-${prop}`, updatedAt: 1 };
      },
    },
  );

  return {
    loadSessionStore: vi.fn(() => sessionStore),
    resolveAgentIdFromSessionKey: (key: string) => {
      const match = key.match(/^agent:([^:]+)/);
      return match?.[1] ?? "main";
    },
    resolveMainSessionKey: () => "agent:main:main",
    resolveStorePath: () => "/tmp/test-store",
    updateSessionStore: vi.fn(),
  };
});

const announceSpy = vi.fn(async (_params: unknown) => true);
const runSubagentEndedHookMock = vi.fn(async (_event?: unknown, _ctx?: unknown) => {});
const emitSessionLifecycleEventMock = vi.fn();
vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "subagent_ended",
    runSubagentEnded: runSubagentEndedHookMock,
  })),
  getGlobalPluginRegistry: vi.fn(() => null),
  hasGlobalHooks: vi.fn((hookName: string) => hookName === "subagent_ended"),
  initializeGlobalHookRunner: vi.fn(),
  resetGlobalHookRunner: vi.fn(),
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: emitSessionLifecycleEventMock,
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry steer restarts", () => {
  let mod: typeof import("./subagent-registry.js");
  type RegisterSubagentRunInput = Parameters<typeof mod.registerSubagentRun>[0];
  const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";
  const MAIN_REQUESTER_DISPLAY_KEY = "main";

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    lifecycleHandler = undefined;
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  const flushAnnounce = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const withPendingAgentWait = async <T>(run: () => Promise<T>): Promise<T> => {
    const callGateway = vi.mocked((await import("../gateway/call.js")).callGateway);
    const originalCallGateway = callGateway.getMockImplementation();
    callGateway.mockImplementation(async (request: unknown) => {
      const typed = request as { method?: string };
      if (typed.method === "agent.wait") {
        return new Promise<unknown>(() => undefined);
      }
      if (originalCallGateway) {
        return originalCallGateway(request as Parameters<typeof callGateway>[0]);
      }
      return {};
    });

    try {
      return await run();
    } finally {
      if (originalCallGateway) {
        callGateway.mockImplementation(originalCallGateway);
      }
    }
  };

  const createDeferredAnnounceResolver = (): ((value: boolean) => void) => {
    let resolveAnnounce!: (value: boolean) => void;
    announceSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAnnounce = resolve;
        }),
    );
    return (value: boolean) => {
      resolveAnnounce(value);
    };
  };

  const registerCompletionModeRun = (
    runId: string,
    childSessionKey: string,
    task: string,
    options: Partial<Pick<RegisterSubagentRunInput, "spawnMode">> = {},
  ): void => {
    registerRun({
      childSessionKey,
      expectsCompletionMessage: true,
      requesterOrigin: {
        accountId: "work",
        channel: "discord",
        to: "channel:123",
      },
      runId,
      task,
      ...options,
    });
  };

  const registerRun = (
    params: {
      runId: string;
      childSessionKey: string;
      task: string;
      requesterSessionKey?: string;
      requesterDisplayKey?: string;
    } & Partial<
      Pick<RegisterSubagentRunInput, "spawnMode" | "requesterOrigin" | "expectsCompletionMessage">
    >,
  ): void => {
    mod.registerSubagentRun({
      childSessionKey: params.childSessionKey,
      cleanup: "keep",
      expectsCompletionMessage: params.expectsCompletionMessage,
      requesterDisplayKey: params.requesterDisplayKey ?? MAIN_REQUESTER_DISPLAY_KEY,
      requesterOrigin: params.requesterOrigin,
      requesterSessionKey: params.requesterSessionKey ?? MAIN_REQUESTER_SESSION_KEY,
      runId: params.runId,
      spawnMode: params.spawnMode,
      task: params.task,
    });
  };

  const listMainRuns = () => mod.listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY);

  const emitLifecycleEnd = (
    runId: string,
    data: {
      startedAt?: number;
      endedAt?: number;
      aborted?: boolean;
      error?: string;
    } = {},
  ) => {
    lifecycleHandler?.({
      data: {
        phase: "end",
        ...data,
      },
      runId,
      stream: "lifecycle",
    });
  };

  const replaceRunAfterSteer = (params: {
    previousRunId: string;
    nextRunId: string;
    fallback?: ReturnType<typeof listMainRuns>[number];
  }) => {
    const replaced = mod.replaceSubagentRunAfterSteer({
      fallback: params.fallback,
      nextRunId: params.nextRunId,
      previousRunId: params.previousRunId,
    });
    expect(replaced).toBe(true);

    const runs = listMainRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe(params.nextRunId);
    return runs[0];
  };

  afterEach(async () => {
    announceSpy.mockClear();
    announceSpy.mockResolvedValue(true);
    runSubagentEndedHookMock.mockClear();
    emitSessionLifecycleEventMock.mockClear();
    lifecycleHandler = undefined;
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  it("suppresses announce for interrupted runs and only announces the replacement run", async () => {
    await withPendingAgentWait(async () => {
      registerRun({
        childSessionKey: "agent:main:subagent:steer",
        runId: "run-old",
        task: "initial task",
      });

      const previous = listMainRuns()[0];
      expect(previous?.runId).toBe("run-old");

      const marked = mod.markSubagentRunForSteerRestart("run-old");
      expect(marked).toBe(true);

      emitLifecycleEnd("run-old");

      await flushAnnounce();
      expect(announceSpy).not.toHaveBeenCalled();
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      expect(emitSessionLifecycleEventMock).not.toHaveBeenCalled();

      replaceRunAfterSteer({
        fallback: previous,
        nextRunId: "run-new",
        previousRunId: "run-old",
      });

      emitLifecycleEnd("run-new");

      await vi.waitFor(() => {
        expect(announceSpy).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
      });
      expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-new",
        }),
        expect.objectContaining({
          runId: "run-new",
        }),
      );

      const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as { childRunId?: string };
      expect(announce.childRunId).toBe("run-new");
    });
  });

  it("defers subagent_ended hook for completion-mode runs until announce delivery resolves", async () => {
    await withPendingAgentWait(async () => {
      const resolveAnnounce = createDeferredAnnounceResolver();
      registerCompletionModeRun(
        "run-completion-delayed",
        "agent:main:subagent:completion-delayed",
        "completion-mode task",
      );

      emitLifecycleEnd("run-completion-delayed");

      await vi.waitFor(() => {
        expect(announceSpy).toHaveBeenCalledTimes(1);
      });
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();

      resolveAnnounce(true);
      await vi.waitFor(() => {
        expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
      });
      expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "subagent-complete",
          sendFarewell: true,
          targetSessionKey: "agent:main:subagent:completion-delayed",
        }),
        expect.objectContaining({
          requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
          runId: "run-completion-delayed",
        }),
      );
    });
  });

  it("does not emit subagent_ended on completion for persistent session-mode runs", async () => {
    await withPendingAgentWait(async () => {
      const resolveAnnounce = createDeferredAnnounceResolver();
      registerCompletionModeRun(
        "run-persistent-session",
        "agent:main:subagent:persistent-session",
        "persistent session task",
        { spawnMode: "session" },
      );

      emitLifecycleEnd("run-persistent-session");

      await flushAnnounce();
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();

      resolveAnnounce(true);
      await flushAnnounce();

      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      const run = listMainRuns()[0];
      expect(run?.runId).toBe("run-persistent-session");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
      expect(run?.endedHookEmittedAt).toBeUndefined();
    });
  });

  it("clears announce retry state when replacing after steer restart", async () => {
    await withPendingAgentWait(async () => {
      registerRun({
        childSessionKey: "agent:main:subagent:retry-reset",
        runId: "run-retry-reset-old",
        task: "retry reset",
      });

      const previous = listMainRuns()[0];
      expect(previous?.runId).toBe("run-retry-reset-old");
      if (previous) {
        previous.announceRetryCount = 2;
        previous.lastAnnounceRetryAt = Date.now();
      }

      const run = replaceRunAfterSteer({
        fallback: previous,
        nextRunId: "run-retry-reset-new",
        previousRunId: "run-retry-reset-old",
      });
      expect(run.announceRetryCount).toBeUndefined();
      expect(run.lastAnnounceRetryAt).toBeUndefined();
    });
  });

  it("clears terminal lifecycle state when replacing after steer restart", async () => {
    await withPendingAgentWait(async () => {
      registerRun({
        childSessionKey: "agent:main:subagent:terminal-state",
        runId: "run-terminal-state-old",
        task: "terminal state",
      });

      const previous = listMainRuns()[0];
      expect(previous?.runId).toBe("run-terminal-state-old");
      if (previous) {
        previous.endedHookEmittedAt = Date.now();
        previous.endedReason = "subagent-complete";
        previous.endedAt = Date.now();
        previous.outcome = { status: "ok" };
      }

      const run = replaceRunAfterSteer({
        fallback: previous,
        nextRunId: "run-terminal-state-new",
        previousRunId: "run-terminal-state-old",
      });
      expect(run.endedHookEmittedAt).toBeUndefined();
      expect(run.endedReason).toBeUndefined();

      emitLifecycleEnd("run-terminal-state-new");

      await vi.waitFor(() => {
        expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: "run-terminal-state-new",
          }),
          expect.objectContaining({
            runId: "run-terminal-state-new",
          }),
        );
      });
      expect(emitSessionLifecycleEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "subagent-status",
          sessionKey: "agent:main:subagent:terminal-state",
        }),
      );
    });
  });

  it("clears frozen completion fields when replacing after steer restart", () => {
    registerRun({
      childSessionKey: "agent:main:subagent:frozen",
      runId: "run-frozen-old",
      task: "frozen result reset",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-frozen-old");
    if (previous) {
      previous.frozenResultText = "stale frozen completion";
      previous.frozenResultCapturedAt = Date.now();
      previous.cleanupCompletedAt = Date.now();
      previous.cleanupHandled = true;
    }

    const run = replaceRunAfterSteer({
      fallback: previous,
      nextRunId: "run-frozen-new",
      previousRunId: "run-frozen-old",
    });

    expect(run.frozenResultText).toBeUndefined();
    expect(run.frozenResultCapturedAt).toBeUndefined();
    expect(run.cleanupCompletedAt).toBeUndefined();
    expect(run.cleanupHandled).toBe(false);
  });

  it("preserves cumulative session timing across steer replacement runs", () => {
    registerRun({
      childSessionKey: "agent:main:subagent:runtime",
      runId: "run-runtime-old",
      task: "keep timing stable",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-runtime-old");
    if (!previous) {
      throw new Error("missing previous run");
    }

    previous.startedAt = 1000;
    previous.sessionStartedAt = 1000;
    previous.endedAt = 121_000;
    previous.accumulatedRuntimeMs = 0;
    previous.outcome = { status: "ok" };

    const replaced = mod.replaceSubagentRunAfterSteer({
      fallback: previous,
      nextRunId: "run-runtime-new",
      previousRunId: "run-runtime-old",
    });
    expect(replaced).toBe(true);

    const next = listMainRuns().find((entry) => entry.runId === "run-runtime-new");
    expect(next).toBeDefined();
    expect(mod.getSubagentSessionStartedAt(next)).toBe(1000);
    expect(next?.accumulatedRuntimeMs).toBe(120_000);

    if (!next?.startedAt) {
      throw new Error("missing next startedAt");
    }
    next.endedAt = next.startedAt + 30_000;
    expect(mod.getSubagentSessionRuntimeMs(next, next.endedAt)).toBe(150_000);
  });

  it("preserves frozen completion as fallback when replacing for wake continuation", () => {
    registerRun({
      childSessionKey: "agent:main:subagent:wake",
      runId: "run-wake-old",
      task: "wake result fallback",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-wake-old");
    if (previous) {
      previous.frozenResultText = "final summary before wake";
      previous.frozenResultCapturedAt = 1234;
    }

    const replaced = mod.replaceSubagentRunAfterSteer({
      fallback: previous,
      nextRunId: "run-wake-new",
      preserveFrozenResultFallback: true,
      previousRunId: "run-wake-old",
    });
    expect(replaced).toBe(true);

    const run = listMainRuns().find((entry) => entry.runId === "run-wake-new");
    expect(run).toMatchObject({
      fallbackFrozenResultCapturedAt: 1234,
      fallbackFrozenResultText: "final summary before wake",
      frozenResultText: undefined,
    });
  });

  it("restores announce for a finished run when steer replacement dispatch fails", async () => {
    registerRun({
      childSessionKey: "agent:main:subagent:failed-restart",
      runId: "run-failed-restart",
      task: "initial task",
    });

    expect(mod.markSubagentRunForSteerRestart("run-failed-restart")).toBe(true);

    emitLifecycleEnd("run-failed-restart");

    await flushAnnounce();
    expect(announceSpy).not.toHaveBeenCalled();

    expect(mod.clearSubagentRunSteerRestart("run-failed-restart")).toBe(true);
    await flushAnnounce();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as { childRunId?: string };
    expect(announce.childRunId).toBe("run-failed-restart");
  });

  it("marks killed runs terminated and inactive", async () => {
    const childSessionKey = "agent:main:subagent:killed";

    registerRun({
      childSessionKey,
      runId: "run-killed",
      task: "kill me",
    });

    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(true);
    const updated = mod.markSubagentRunTerminated({
      childSessionKey,
      reason: "manual kill",
    });
    expect(updated).toBe(1);
    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);

    const run = listMainRuns()[0];
    expect(run?.outcome).toEqual({ error: "manual kill", status: "error" });
    expect(run?.cleanupHandled).toBe(true);
    expect(typeof run?.cleanupCompletedAt).toBe("number");
    await vi.waitFor(() => {
      expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
        {
          accountId: undefined,
          endedAt: expect.any(Number),
          error: "manual kill",
          outcome: "killed",
          reason: "subagent-killed",
          runId: "run-killed",
          sendFarewell: true,
          targetKind: "subagent",
          targetSessionKey: childSessionKey,
        },
        {
          childSessionKey,
          requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
          runId: "run-killed",
        },
      );
    });
  });

  it("treats a child session as inactive when only a stale older row is still unended", async () => {
    const childSessionKey = "agent:main:subagent:stale-active-older-row";

    mod.addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      createdAt: 100,
      requesterDisplayKey: MAIN_REQUESTER_DISPLAY_KEY,
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      runId: "run-stale-older",
      startedAt: 100,
      task: "older stale row",
    });
    mod.addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      createdAt: 200,
      endedAt: 250,
      outcome: { status: "ok" },
      requesterDisplayKey: MAIN_REQUESTER_DISPLAY_KEY,
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      runId: "run-current-ended",
      startedAt: 200,
      task: "current ended row",
    });

    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);
  });

  it("recovers announce cleanup when completion arrives after a kill marker", async () => {
    const childSessionKey = "agent:main:subagent:kill-race";
    registerRun({
      childSessionKey,
      runId: "run-kill-race",
      task: "race test",
    });

    expect(mod.markSubagentRunTerminated({ reason: "manual kill", runId: "run-kill-race" })).toBe(
      1,
    );
    expect(listMainRuns()[0]?.suppressAnnounceReason).toBe("killed");
    expect(listMainRuns()[0]?.cleanupHandled).toBe(true);
    expect(typeof listMainRuns()[0]?.cleanupCompletedAt).toBe("number");

    emitLifecycleEnd("run-kill-race");
    await flushAnnounce();
    await flushAnnounce();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as { childRunId?: string };
    expect(announce.childRunId).toBe("run-kill-race");

    const run = listMainRuns()[0];
    expect(run?.endedReason).toBe("subagent-complete");
    expect(run?.outcome?.status).not.toBe("error");
    expect(run?.suppressAnnounceReason).toBeUndefined();
    expect(run?.cleanupHandled).toBe(true);
    expect(typeof run?.cleanupCompletedAt).toBe("number");
    expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
  });

  it("retries deferred parent cleanup after a descendant announces", async () => {
    let parentAttempts = 0;
    announceSpy.mockImplementation(async (params: unknown) => {
      const typed = params as { childRunId?: string };
      if (typed.childRunId === "run-parent") {
        parentAttempts += 1;
        return parentAttempts >= 2;
      }
      return true;
    });

    registerRun({
      childSessionKey: "agent:main:subagent:parent",
      runId: "run-parent",
      task: "parent task",
    });
    registerRun({
      childSessionKey: "agent:main:subagent:parent:subagent:child",
      requesterDisplayKey: "parent",
      requesterSessionKey: "agent:main:subagent:parent",
      runId: "run-child",
      task: "child task",
    });

    emitLifecycleEnd("run-parent");
    await flushAnnounce();

    emitLifecycleEnd("run-child");
    await flushAnnounce();

    const childRunIds = announceSpy.mock.calls.map(
      (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
    );
    expect(childRunIds.filter((id) => id === "run-parent")).toHaveLength(2);
    expect(childRunIds.filter((id) => id === "run-child")).toHaveLength(1);
  });

  it("retries completion-mode announce delivery with backoff and then gives up after retry limit", async () => {
    await withPendingAgentWait(async () => {
      vi.useFakeTimers();
      try {
        announceSpy.mockResolvedValue(false);

        registerCompletionModeRun(
          "run-completion-retry",
          "agent:main:subagent:completion",
          "completion retry",
        );

        emitLifecycleEnd("run-completion-retry");

        await vi.advanceTimersByTimeAsync(0);
        expect(announceSpy).toHaveBeenCalledTimes(1);
        expect(listMainRuns()[0]?.announceRetryCount).toBe(1);

        await vi.advanceTimersByTimeAsync(999);
        expect(announceSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(announceSpy).toHaveBeenCalledTimes(2);
        expect(listMainRuns()[0]?.announceRetryCount).toBe(2);

        await vi.advanceTimersByTimeAsync(1999);
        expect(announceSpy).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(announceSpy).toHaveBeenCalledTimes(3);
        expect(listMainRuns()[0]?.announceRetryCount).toBe(3);

        await vi.advanceTimersByTimeAsync(4001);
        expect(announceSpy).toHaveBeenCalledTimes(3);
        expect(listMainRuns()[0]?.cleanupCompletedAt).toBeTypeOf("number");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("keeps completion cleanup pending while descendants are still active", async () => {
    announceSpy.mockResolvedValue(false);

    registerCompletionModeRun(
      "run-parent-expiry",
      "agent:main:subagent:parent-expiry",
      "parent completion expiry",
    );
    registerRun({
      childSessionKey: "agent:main:subagent:parent-expiry:subagent:child-active",
      requesterDisplayKey: "parent-expiry",
      requesterSessionKey: "agent:main:subagent:parent-expiry",
      runId: "run-child-active",
      task: "child still running",
    });

    emitLifecycleEnd("run-parent-expiry", {
      endedAt: Date.now() - 6 * 60_000,
      startedAt: Date.now() - 7 * 60_000,
    });

    await flushAnnounce();

    const parentHookCall = runSubagentEndedHookMock.mock.calls.find((call) => {
      const event = call[0] as { runId?: string; reason?: string };
      return event.runId === "run-parent-expiry" && event.reason === "subagent-complete";
    });
    expect(parentHookCall).toBeUndefined();
    const parent = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((entry) => entry.runId === "run-parent-expiry");
    expect(parent?.cleanupCompletedAt).toBeUndefined();
    expect(parent?.cleanupHandled).toBe(false);
  });
});
