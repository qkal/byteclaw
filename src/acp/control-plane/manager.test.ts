import { setTimeout as scheduleNativeTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "../../config/sessions/types.js";
import { resetHeartbeatWakeStateForTests } from "../../infra/heartbeat-wake.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import type { AcpRuntime, AcpRuntimeCapabilities } from "../runtime/types.js";

const hoisted = vi.hoisted(() => {
  const listAcpSessionEntriesMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const upsertAcpSessionMetaMock = vi.fn();
  const getAcpRuntimeBackendMock = vi.fn();
  const requireAcpRuntimeBackendMock = vi.fn();
  return {
    getAcpRuntimeBackendMock,
    listAcpSessionEntriesMock,
    readAcpSessionEntryMock,
    requireAcpRuntimeBackendMock,
    upsertAcpSessionMetaMock,
  };
});

vi.mock("../runtime/session-meta.js", () => ({
  listAcpSessionEntries: (params: unknown) => hoisted.listAcpSessionEntriesMock(params),
  readAcpSessionEntry: (params: unknown) => hoisted.readAcpSessionEntryMock(params),
  upsertAcpSessionMeta: (params: unknown) => hoisted.upsertAcpSessionMetaMock(params),
}));

vi.mock("../runtime/registry.js", async () => {
  const actual =
    await vi.importActual<typeof import("../runtime/registry.js")>("../runtime/registry.js");
  return {
    ...actual,
    getAcpRuntimeBackend: (backendId?: string) => hoisted.getAcpRuntimeBackendMock(backendId),
    requireAcpRuntimeBackend: (backendId?: string) =>
      hoisted.requireAcpRuntimeBackendMock(backendId),
  };
});

let AcpSessionManager: typeof import("./manager.js").AcpSessionManager;
let AcpRuntimeError: typeof import("../runtime/errors.js").AcpRuntimeError;
let resetAcpSessionManagerForTests: typeof import("./manager.js").__testing.resetAcpSessionManagerForTests;
let findTaskByRunId: typeof import("../../tasks/task-registry.js").findTaskByRunId;
let resetTaskRegistryForTests: typeof import("../../tasks/task-registry.js").resetTaskRegistryForTests;
let resetTaskFlowRegistryForTests: typeof import("../../tasks/task-flow-registry.js").resetTaskFlowRegistryForTests;
let installInMemoryTaskRegistryRuntime: typeof import("../../test-utils/task-registry-runtime.js").installInMemoryTaskRegistryRuntime;
let configureTaskFlowRegistryRuntime: typeof import("../../tasks/task-flow-registry.store.js").configureTaskFlowRegistryRuntime;

const baseCfg = {
  acp: {
    backend: "acpx",
    dispatch: { enabled: true },
    enabled: true,
  },
} as const;
const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withAcpManagerTaskStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withTempDir({ prefix: "openclaw-acp-manager-task-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    installInMemoryTaskRegistryRuntime();
    configureTaskFlowRegistryRuntime({
      store: {
        close: () => {},
        deleteFlow: () => {},
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
        upsertFlow: () => {},
      },
    });
    try {
      await run(root);
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

function createRuntime(): {
  runtime: AcpRuntime;
  ensureSession: ReturnType<typeof vi.fn>;
  runTurn: ReturnType<typeof vi.fn>;
  prepareFreshSession: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getCapabilities: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  setConfigOption: ReturnType<typeof vi.fn>;
} {
  const ensureSession = vi.fn(
    async (input: { sessionKey: string; agent: string; mode: "persistent" | "oneshot" }) => ({
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
      sessionKey: input.sessionKey,
    }),
  );
  const runTurn = vi.fn(async function*  runTurn() {
    yield { type: "done" as const };
  });
  const prepareFreshSession = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const getCapabilities = vi.fn(
    async (): Promise<AcpRuntimeCapabilities> => ({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
    }),
  );
  const getStatus = vi.fn(async () => ({
    details: { status: "alive" },
    summary: "status=alive",
  }));
  const setMode = vi.fn(async () => {});
  const setConfigOption = vi.fn(async () => {});
  return {
    cancel,
    close,
    ensureSession,
    getCapabilities,
    getStatus,
    prepareFreshSession,
    runTurn,
    runtime: {
      cancel,
      close,
      ensureSession,
      getCapabilities,
      getStatus,
      prepareFreshSession,
      runTurn,
      setConfigOption,
      setMode,
    },
    setConfigOption,
    setMode,
  };
}

function readySessionMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return {
    agent: "codex",
    backend: "acpx",
    lastActivityAt: Date.now(),
    mode: "persistent" as const,
    runtimeSessionName: "runtime-1",
    state: "idle" as const,
    ...overrides,
  };
}

function extractStatesFromUpserts(): SessionAcpMeta["state"][] {
  const states: SessionAcpMeta["state"][] = [];
  for (const [firstArg] of hoisted.upsertAcpSessionMetaMock.mock.calls) {
    const payload = firstArg as {
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const current = readySessionMeta();
    const next = payload.mutate(current, { acp: current });
    if (next?.state) {
      states.push(next.state);
    }
  }
  return states;
}

function extractRuntimeOptionsFromUpserts(): (AcpSessionRuntimeOptions | undefined)[] {
  const options: (AcpSessionRuntimeOptions | undefined)[] = [];
  for (const [firstArg] of hoisted.upsertAcpSessionMetaMock.mock.calls) {
    const payload = firstArg as {
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const current = readySessionMeta();
    const next = payload.mutate(current, { acp: current });
    if (next) {
      options.push(next.runtimeOptions);
    }
  }
  return options;
}

describe("AcpSessionManager", () => {
  beforeAll(async () => {
    ({
      AcpSessionManager,
      __testing: { resetAcpSessionManagerForTests },
    } = await import("./manager.js"));
    ({ AcpRuntimeError } = await import("../runtime/errors.js"));
    ({ findTaskByRunId, resetTaskRegistryForTests } = await import("../../tasks/task-registry.js"));
    ({ resetTaskFlowRegistryForTests } = await import("../../tasks/task-flow-registry.js"));
    ({ configureTaskFlowRegistryRuntime } =
      await import("../../tasks/task-flow-registry.store.js"));
    ({ installInMemoryTaskRegistryRuntime } =
      await import("../../test-utils/task-registry-runtime.js"));
  });

  beforeEach(() => {
    resetAcpSessionManagerForTests();
    vi.useRealTimers();
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.readAcpSessionEntryMock.mockReset();
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockReset();
    hoisted.getAcpRuntimeBackendMock.mockReset().mockImplementation((backendId?: string) => {
      try {
        return hoisted.requireAcpRuntimeBackendMock(backendId);
      } catch {
        return null;
      }
    });
  });

  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("marks ACP-shaped sessions without metadata as stale", () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue(null);
    const manager = new AcpSessionManager();

    const resolved = manager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(resolved.kind).toBe("stale");
    if (resolved.kind !== "stale") {
      return;
    }
    expect(resolved.error.code).toBe("ACP_SESSION_INIT_FAILED");
    expect(resolved.error.message).toContain("ACP metadata is missing");
  });

  it("canonicalizes the main alias before ACP rehydrate after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const {sessionKey} = (paramsUnknown as { sessionKey?: string });
      if (sessionKey !== "agent:main:main") {
        return null;
      }
      return {
        acp: {
          ...readySessionMeta(),
          agent: "main",
          runtimeSessionName: sessionKey,
        },
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });

    const manager = new AcpSessionManager();
    const cfg = {
      ...baseCfg,
      agents: { list: [{ default: true, id: "main" }] },
      session: { mainKey: "main" },
    } as OpenClawConfig;

    await manager.runTurn({
      cfg,
      mode: "prompt",
      requestId: "r-main",
      sessionKey: "main",
      text: "after restart",
    });

    expect(hoisted.readAcpSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        sessionKey: "agent:main:main",
      }),
    );
    expect(runtimeState.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "main",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("tracks parented direct ACP turns in the task registry", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.runTurn.mockImplementation(async function* () {
        yield {
          stream: "output" as const,
          text: "Write failed: permission denied for /root/oc-acp-write-should-fail.txt.",
          type: "text_delta" as const,
        };
        yield { type: "done" as const };
      });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const {sessionKey} = (paramsUnknown as { sessionKey?: string });
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            acp: readySessionMeta(),
            entry: {
              label: "Quant patch",
              sessionId: "child-1",
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              updatedAt: Date.now(),
            },
            sessionKey,
            storeSessionKey: sessionKey,
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
            sessionKey,
            storeSessionKey: sessionKey,
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      await manager.runTurn({
        cfg: baseCfg,
        mode: "prompt",
        requestId: "direct-parented-run",
        sessionKey: "agent:codex:acp:child-1",
        text: "Implement the feature and report back",
      });
      await flushMicrotasks();

      expect(findTaskByRunId("direct-parented-run")).toMatchObject({
        childSessionKey: "agent:codex:acp:child-1",
        label: "Quant patch",
        ownerKey: "agent:quant:telegram:quant:direct:822430204",
        progressSummary: "Write failed: permission denied for /root/oc-acp-write-should-fail.txt.",
        runtime: "acp",
        scopeKind: "session",
        status: "succeeded",
        task: "Implement the feature and report back",
        terminalOutcome: "blocked",
        terminalSummary: "Permission denied for /root/oc-acp-write-should-fail.txt.",
      });
    });
  }, 300_000);

  it("serializes concurrent turns for the same ACP session", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    let inFlight = 0;
    let maxInFlight = 0;
    runtimeState.runTurn.mockImplementation(async function* (_input: { requestId: string }) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await sleep(10);
        yield { type: "done" };
      } finally {
        inFlight -= 1;
      }
    });

    const manager = new AcpSessionManager();
    const first = manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
    });
    const second = manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r2",
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
    });
    await Promise.all([first, second]);

    expect(maxInFlight).toBe(1);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("rejects a queued turn promptly when its caller aborts before the actor is free", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    let firstTurnStarted = false;
    let releaseFirstTurn: (() => void) | undefined;
    runtimeState.runTurn.mockImplementation(async function* (input: { requestId: string }) {
      if (input.requestId === "r1") {
        firstTurnStarted = true;
        await new Promise<void>((resolve) => {
          releaseFirstTurn = resolve;
        });
      }
      yield { type: "done" as const };
    });

    const manager = new AcpSessionManager();
    const first = manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
    });
    await vi.waitFor(() => {
      expect(firstTurnStarted).toBe(true);
    });

    const abortController = new AbortController();
    const second = manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r2",
      sessionKey: "agent:codex:acp:session-1",
      signal: abortController.signal,
      text: "second",
    });
    abortController.abort();

    const secondOutcome = await Promise.race([
      second.then(
        () => ({ status: "resolved" as const }),
        (error) => ({ error, status: "rejected" as const }),
      ),
      new Promise<{ status: "pending" }>((resolve) => {
        scheduleNativeTimeout(() => resolve({ status: "pending" }), 100);
      }),
    ]);

    releaseFirstTurn?.();
    await first;
    await vi.waitFor(() => {
      expect(manager.getObservabilitySnapshot(baseCfg).turns.queueDepth).toBe(0);
    });

    expect(secondOutcome.status).toBe("rejected");
    if (secondOutcome.status !== "rejected") {
      return;
    }
    expect(secondOutcome.error).toBeInstanceOf(AcpRuntimeError);
    expect(secondOutcome.error).toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "ACP operation aborted.",
    });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
  });

  it("times out a hung persistent turn without closing the session and lets queued work continue", async () => {
    vi.useFakeTimers();
    try {
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockReturnValue({
        acp: readySessionMeta(),
        sessionKey: "agent:codex:acp:session-1",
        storeSessionKey: "agent:codex:acp:session-1",
      });

      let firstTurnStarted = false;
      runtimeState.runTurn.mockImplementation(async function* (input: { requestId: string }) {
        if (input.requestId === "r1") {
          firstTurnStarted = true;
          await new Promise(() => {});
        }
        yield { type: "done" as const };
      });

      const manager = new AcpSessionManager();
      const cfg = {
        ...baseCfg,
        agents: {
          defaults: {
            timeoutSeconds: 1,
          },
        },
      } as OpenClawConfig;

      const first = manager.runTurn({
        cfg,
        mode: "prompt",
        requestId: "r1",
        sessionKey: "agent:codex:acp:session-1",
        text: "first",
      });
      void first.catch(() => undefined);
      await vi.waitFor(() => {
        expect(firstTurnStarted).toBe(true);
      });

      const second = manager.runTurn({
        cfg,
        mode: "prompt",
        requestId: "r2",
        sessionKey: "agent:codex:acp:session-1",
        text: "second",
      });

      await vi.advanceTimersByTimeAsync(3500);

      await expect(first).rejects.toMatchObject({
        code: "ACP_TURN_FAILED",
        message: "ACP turn timed out after 1s.",
      });
      await expect(second).resolves.toBeUndefined();

      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
      expect(runtimeState.cancel).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "turn-timeout",
        }),
      );
      expect(runtimeState.close).not.toHaveBeenCalled();
      expect(manager.getObservabilitySnapshot(cfg)).toMatchObject({
        runtimeCache: {
          activeSessions: 1,
        },
        turns: {
          active: 0,
          completed: 1,
          failed: 1,
          queueDepth: 0,
        },
      });

      const states = extractStatesFromUpserts();
      expect(states).toContain("error");
      expect(states.at(-1)).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps timed-out runtime handles counted until timeout cleanup finishes", async () => {
    vi.useFakeTimers();
    try {
      const runtimeState = createRuntime();
      runtimeState.cancel.mockImplementation(() => new Promise(() => {}));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
        return {
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `runtime:${sessionKey}`,
          },
          sessionKey,
          storeSessionKey: sessionKey,
        };
      });

      let firstTurnStarted = false;
      runtimeState.runTurn.mockImplementation(async function* (input: { requestId: string }) {
        if (input.requestId === "r1") {
          firstTurnStarted = true;
          await new Promise(() => {});
        }
        yield { type: "done" as const };
      });

      const manager = new AcpSessionManager();
      const cfg = {
        ...baseCfg,
        acp: {
          ...baseCfg.acp,
          maxConcurrentSessions: 1,
        },
        agents: {
          defaults: {
            timeoutSeconds: 1,
          },
        },
      } as OpenClawConfig;

      const first = manager.runTurn({
        cfg,
        mode: "prompt",
        requestId: "r1",
        sessionKey: "agent:codex:acp:session-a",
        text: "first",
      });
      void first.catch(() => undefined);
      await vi.waitFor(() => {
        expect(firstTurnStarted).toBe(true);
      });

      await vi.advanceTimersByTimeAsync(4500);

      await expect(first).rejects.toMatchObject({
        code: "ACP_TURN_FAILED",
        message: "ACP turn timed out after 1s.",
      });
      expect(manager.getObservabilitySnapshot(cfg).runtimeCache.activeSessions).toBe(1);

      await expect(
        manager.runTurn({
          cfg,
          mode: "prompt",
          requestId: "r2",
          sessionKey: "agent:codex:acp:session-b",
          text: "second",
        }),
      ).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: expect.stringContaining("max concurrent sessions"),
      });
      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs turns for different ACP sessions in parallel", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });

    let inFlight = 0;
    let maxInFlight = 0;
    runtimeState.runTurn.mockImplementation(async function* () {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await sleep(15);
        yield { type: "done" as const };
      } finally {
        inFlight -= 1;
      }
    });

    const manager = new AcpSessionManager();
    await Promise.all([
      manager.runTurn({
        cfg: baseCfg,
        mode: "prompt",
        requestId: "r1",
        sessionKey: "agent:codex:acp:session-a",
        text: "first",
      }),
      manager.runTurn({
        cfg: baseCfg,
        mode: "prompt",
        requestId: "r2",
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
      }),
    ]);

    expect(maxInFlight).toBe(2);
  });

  it("reuses runtime session handles for repeat turns in the same manager process", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
    });
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r2",
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("re-ensures cached runtime handles when the backend reports the session is dead", async () => {
    const runtimeState = createRuntime();
    runtimeState.getStatus
      .mockResolvedValueOnce({
        details: { status: "alive" },
        summary: "status=alive",
      })
      .mockResolvedValueOnce({
        details: { status: "dead" },
        summary: "status=dead",
      })
      .mockResolvedValueOnce({
        details: { status: "alive" },
        summary: "status=alive",
      });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
    });
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r2",
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(3);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("re-ensures cached runtime handles when persisted ACP session identity changes", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession
      .mockResolvedValueOnce({
        acpxRecordId: "record-1",
        agentSessionId: "agent-session-1",
        backend: "acpx",
        backendSessionId: "acpx-session-1",
        runtimeSessionName: "runtime-1",
        sessionKey: "agent:codex:acp:session-1",
      })
      .mockResolvedValueOnce({
        acpxRecordId: "record-1",
        agentSessionId: "agent-session-2",
        backend: "acpx",
        backendSessionId: "acpx-session-2",
        runtimeSessionName: "runtime-2",
        sessionKey: "agent:codex:acp:session-1",
      });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    let currentMeta = readySessionMeta({
      identity: {
        acpxRecordId: "record-1",
        acpxSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
        lastUpdatedAt: Date.now(),
        source: "status",
        state: "resolved",
      },
      runtimeSessionName: "runtime-1",
    });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      acp: currentMeta,
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    }));

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
    });

    currentMeta = readySessionMeta({
      identity: {
        acpxRecordId: "record-1",
        acpxSessionId: "acpx-session-2",
        agentSessionId: "agent-session-2",
        lastUpdatedAt: Date.now(),
        source: "status",
        state: "resolved",
      },
      runtimeSessionName: "runtime-2",
    });

    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r2",
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("rehydrates runtime handles after a manager restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    const managerA = new AcpSessionManager();
    await managerA.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey: "agent:codex:acp:session-1",
      text: "before restart",
    });
    const managerB = new AcpSessionManager();
    await managerB.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r2",
      sessionKey: "agent:codex:acp:session-1",
      text: "after restart",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("passes persisted ACP backend session identity back into ensureSession for configured bindings after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:deadbeef";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        acp: {
          ...readySessionMeta(),
          identity: {
            acpxSessionId: "acpx-sid-1",
            lastUpdatedAt: Date.now(),
            source: "status",
            state: "resolved",
          },
          runtimeSessionName: key,
        },
        sessionKey: key,
        storeSessionKey: key,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r-binding-restart",
      sessionKey,
      text: "after restart",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        resumeSessionId: "acpx-sid-1",
        sessionKey,
      }),
    );
  });

  it("prefers the persisted agent session id when reopening an ACP runtime after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:gemini:acp:binding:discord:default:restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        acp: {
          ...readySessionMeta(),
          agent: "gemini",
          identity: {
            acpxSessionId: "acpx-sid-1",
            agentSessionId: "gemini-sid-1",
            lastUpdatedAt: Date.now(),
            source: "status",
            state: "resolved",
          },
          runtimeSessionName: key,
        },
        sessionKey: key,
        storeSessionKey: key,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r-binding-restart-gemini",
      sessionKey,
      text: "after restart",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "gemini",
        resumeSessionId: "gemini-sid-1",
        sessionKey,
      }),
    );
  });

  it("passes persisted cwd runtime options into ensureSession after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:cwd-restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        acp: {
          ...readySessionMeta(),
          cwd: "/workspace/stale",
          runtimeOptions: {
            cwd: "/workspace/project",
          },
        },
        sessionKey: key,
        storeSessionKey: key,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r-binding-restart-cwd",
      sessionKey,
      text: "after restart",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/workspace/project",
        sessionKey,
      }),
    );
  });

  it("does not resume persisted ACP identity for oneshot sessions after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:oneshot";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        acp: {
          ...readySessionMeta(),
          identity: {
            acpxSessionId: "acpx-sid-oneshot",
            lastUpdatedAt: Date.now(),
            source: "status",
            state: "resolved",
          },
          mode: "oneshot",
          runtimeSessionName: key,
        },
        sessionKey: key,
        storeSessionKey: key,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r-binding-oneshot",
      sessionKey,
      text: "after restart",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    const ensureInput = runtimeState.ensureSession.mock.calls[0]?.[0] as
      | { resumeSessionId?: string; mode?: string }
      | undefined;
    expect(ensureInput).toMatchObject({
      agent: "codex",
      mode: "oneshot",
      sessionKey,
    });
    expect(ensureInput?.resumeSessionId).toBeUndefined();
  });

  it("falls back to a fresh ensure without reusing stale agent session ids", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockImplementation(async (inputUnknown: unknown) => {
      const input = inputUnknown as {
        sessionKey: string;
        agent: string;
        mode: "persistent" | "oneshot";
        resumeSessionId?: string;
      };
      if (input.resumeSessionId) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "failed to resume persisted ACP session",
        );
      }
      return {
        backend: "acpx",
        backendSessionId: "acpx-sid-fresh",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        sessionKey: input.sessionKey,
      };
    });
    runtimeState.getStatus.mockResolvedValue({
      backendSessionId: "acpx-sid-fresh",
      details: { status: "alive" },
      summary: "status=alive",
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:retry-fresh";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        acpxSessionId: "acpx-sid-stale",
        agentSessionId: "agent-sid-stale",
        lastUpdatedAt: Date.now(),
        source: "status",
        state: "resolved",
      },
      runtimeSessionName: sessionKey,
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        acp: currentMeta,
        sessionKey: key,
        storeSessionKey: key,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        acp: currentMeta,
        sessionId: "session-1",
        updatedAt: Date.now(),
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r-binding-retry-fresh",
      sessionKey,
      text: "after restart",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.ensureSession.mock.calls[0]?.[0]).toMatchObject({
      agent: "codex",
      resumeSessionId: "agent-sid-stale",
      sessionKey,
    });
    const retryInput = runtimeState.ensureSession.mock.calls[1]?.[0] as
      | { resumeSessionId?: string }
      | undefined;
    expect(retryInput?.resumeSessionId).toBeUndefined();
    const runTurnInput = runtimeState.runTurn.mock.calls[0]?.[0] as
      | { handle?: { agentSessionId?: string; backendSessionId?: string } }
      | undefined;
    expect(runTurnInput?.handle?.backendSessionId).toBe("acpx-sid-fresh");
    expect(runTurnInput?.handle?.agentSessionId).toBeUndefined();
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-sid-fresh");
    expect(currentMeta.identity?.agentSessionId).toBeUndefined();
  });

  it("enforces acp.maxConcurrentSessions when opening new runtime handles", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });
    const limitedCfg = {
      acp: {
        ...baseCfg.acp,
        maxConcurrentSessions: 1,
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: limitedCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey: "agent:codex:acp:session-a",
      text: "first",
    });

    await expect(
      manager.runTurn({
        cfg: limitedCfg,
        mode: "prompt",
        requestId: "r2",
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("max concurrent sessions"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("enforces acp.maxConcurrentSessions during initializeSession", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-a",
      storeSessionKey: "agent:codex:acp:session-a",
    });
    const limitedCfg = {
      acp: {
        ...baseCfg.acp,
        maxConcurrentSessions: 1,
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      agent: "codex",
      cfg: limitedCfg,
      mode: "persistent",
      sessionKey: "agent:codex:acp:session-a",
    });

    await expect(
      manager.initializeSession({
        agent: "codex",
        cfg: limitedCfg,
        mode: "persistent",
        sessionKey: "agent:codex:acp:session-b",
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("max concurrent sessions"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("drops cached runtime handles when close tolerates backend-unavailable errors", async () => {
    const runtimeState = createRuntime();
    runtimeState.close.mockRejectedValueOnce(
      new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "runtime temporarily unavailable"),
    );
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });
    const limitedCfg = {
      acp: {
        ...baseCfg.acp,
        maxConcurrentSessions: 1,
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: limitedCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey: "agent:codex:acp:session-a",
      text: "first",
    });

    const closeResult = await manager.closeSession({
      allowBackendUnavailable: true,
      cfg: limitedCfg,
      reason: "manual-close",
      sessionKey: "agent:codex:acp:session-a",
    });
    expect(closeResult.runtimeClosed).toBe(false);
    expect(closeResult.runtimeNotice).toContain("temporarily unavailable");

    await expect(
      manager.runTurn({
        cfg: limitedCfg,
        mode: "prompt",
        requestId: "r2",
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
      }),
    ).resolves.toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("drops cached runtime handles when close sees a stale acpx process-exit error", async () => {
    const runtimeState = createRuntime();
    runtimeState.close.mockRejectedValueOnce(new Error("acpx exited with code 1"));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });
    const limitedCfg = {
      acp: {
        ...baseCfg.acp,
        maxConcurrentSessions: 1,
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: limitedCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey: "agent:codex:acp:session-a",
      text: "first",
    });

    const closeResult = await manager.closeSession({
      allowBackendUnavailable: true,
      cfg: limitedCfg,
      reason: "manual-close",
      sessionKey: "agent:codex:acp:session-a",
    });
    expect(closeResult.runtimeClosed).toBe(false);
    expect(closeResult.runtimeNotice).toBe("acpx exited with code 1");

    await expect(
      manager.runTurn({
        cfg: limitedCfg,
        mode: "prompt",
        requestId: "r2",
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
      }),
    ).resolves.toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("treats stale session init failures as recoverable during discard resets", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockRejectedValueOnce(
      new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Could not initialize ACP session runtime."),
    );
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta({
        agent: "claude",
      }),
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
    });

    const manager = new AcpSessionManager();
    const closeResult = await manager.closeSession({
      allowBackendUnavailable: true,
      cfg: baseCfg,
      discardPersistentState: true,
      reason: "new-in-place-reset",
      sessionKey: "agent:claude:acp:session-1",
    });

    expect(closeResult.runtimeClosed).toBe(false);
    expect(closeResult.runtimeNotice).toBe("Could not initialize ACP session runtime.");
    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey: "agent:claude:acp:session-1",
    });
  });

  it("clears persisted resume identity when close discards persistent state", async () => {
    const runtimeState = createRuntime();
    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
    const entry = {
      acp: readySessionMeta({
        agent: "claude",
        identity: {
          acpxRecordId: sessionKey,
          acpxSessionId: "acpx-session-1",
          agentSessionId: "agent-session-1",
          lastUpdatedAt: 1,
          source: "status",
          state: "resolved",
        },
        lastError: "stale failure",
        state: "running",
      }),
      sessionKey,
      storeSessionKey: sessionKey,
    };
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => entry);
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(entry.acp, entry);
      if (next === null) {
        return null;
      }
      if (next) {
        entry.acp = next;
      }
      return entry;
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      allowBackendUnavailable: true,
      cfg: baseCfg,
      clearMeta: false,
      discardPersistentState: true,
      reason: "new-in-place-reset",
      sessionKey,
    });

    expect(result.runtimeClosed).toBe(true);
    expect(entry.acp?.state).toBe("idle");
    expect(entry.acp?.lastError).toBeUndefined();
    expect(entry.acp?.identity).toMatchObject({
      acpxRecordId: sessionKey,
      source: "status",
      state: "pending",
    });
    expect(entry.acp?.identity).not.toHaveProperty("acpxSessionId");
    expect(entry.acp?.identity).not.toHaveProperty("agentSessionId");
  });

  it("prepares a fresh persistent session before ensure when metadata has no stable session id", async () => {
    const runtimeState = createRuntime();
    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
    runtimeState.ensureSession.mockResolvedValue({
      acpxRecordId: sessionKey,
      backend: "acpx",
      backendSessionId: "acpx-session-fresh",
      runtimeSessionName: "runtime-fresh",
      sessionKey,
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = readySessionMeta({
      agent: "claude",
      identity: {
        acpxRecordId: sessionKey,
        lastUpdatedAt: Date.now(),
        source: "status",
        state: "pending",
      },
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        acp: currentMeta,
        sessionKey: key,
        storeSessionKey: key,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        acp: currentMeta,
        sessionId: "session-1",
        updatedAt: Date.now(),
      };
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        mode: "prompt",
        requestId: "r-fresh",
        sessionKey,
        text: "who are you?",
      }),
    ).resolves.toBeUndefined();

    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey,
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
      }),
    );
    expect(runtimeState.prepareFreshSession.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeState.ensureSession.mock.invocationCallOrder[0],
    );
  });

  it("skips runtime re-ensure when discarding a pending persistent session", async () => {
    const runtimeState = createRuntime();
    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
    hoisted.getAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const entry = {
      acp: readySessionMeta({
        agent: "claude",
        identity: {
          acpxRecordId: sessionKey,
          lastUpdatedAt: Date.now(),
          source: "ensure",
          state: "pending",
        },
      }),
      sessionKey,
      storeSessionKey: sessionKey,
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => entry);
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(entry.acp, entry);
      if (next === null) {
        return null;
      }
      if (next) {
        entry.acp = next;
      }
      return entry;
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      allowBackendUnavailable: true,
      cfg: baseCfg,
      clearMeta: false,
      discardPersistentState: true,
      reason: "new-in-place-reset",
      sessionKey,
    });

    expect(result.runtimeClosed).toBe(false);
    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey,
    });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.close).not.toHaveBeenCalled();
    expect(entry.acp?.identity).toMatchObject({
      acpxRecordId: sessionKey,
      source: "ensure",
      state: "pending",
    });
    expect(entry.acp?.identity).not.toHaveProperty("acpxSessionId");
    expect(entry.acp?.identity).not.toHaveProperty("agentSessionId");
  });

  it("evicts idle cached runtimes before enforcing max concurrent limits", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-23T00:00:00.000Z"));
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
        return {
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `runtime:${sessionKey}`,
          },
          sessionKey,
          storeSessionKey: sessionKey,
        };
      });
      const cfg = {
        acp: {
          ...baseCfg.acp,
          maxConcurrentSessions: 1,
          runtime: {
            ttlMinutes: 0.01,
          },
        },
      } as OpenClawConfig;

      const manager = new AcpSessionManager();
      await manager.runTurn({
        cfg,
        mode: "prompt",
        requestId: "r1",
        sessionKey: "agent:codex:acp:session-a",
        text: "first",
      });

      vi.advanceTimersByTime(2000);
      await manager.runTurn({
        cfg,
        mode: "prompt",
        requestId: "r2",
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
      });

      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
      expect(runtimeState.close).toHaveBeenCalledWith(
        expect.objectContaining({
          handle: expect.objectContaining({
            sessionKey: "agent:codex:acp:session-a",
          }),
          reason: "idle-evicted",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks ACP turn latency and error-code observability", async () => {
    const runtimeState = createRuntime();
    runtimeState.runTurn.mockImplementation(async function* (input: { requestId: string }) {
      if (input.requestId === "fail") {
        throw new Error("runtime exploded");
      }
      yield { type: "done" as const };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "ok",
      sessionKey: "agent:codex:acp:session-1",
      text: "ok",
    });
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        mode: "prompt",
        requestId: "fail",
        sessionKey: "agent:codex:acp:session-1",
        text: "boom",
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
    });

    const snapshot = manager.getObservabilitySnapshot(baseCfg);
    expect(snapshot.turns.completed).toBe(1);
    expect(snapshot.turns.failed).toBe(1);
    expect(snapshot.turns.active).toBe(0);
    expect(snapshot.turns.queueDepth).toBe(0);
    expect(snapshot.errorsByCode.ACP_TURN_FAILED).toBe(1);
  });

  it("rolls back ensured runtime sessions when metadata persistence fails", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));

    const manager = new AcpSessionManager();
    await expect(
      manager.initializeSession({
        agent: "codex",
        cfg: baseCfg,
        mode: "persistent",
        sessionKey: "agent:codex:acp:session-1",
      }),
    ).rejects.toThrow("disk full");
    expect(runtimeState.close).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.objectContaining({
          sessionKey: "agent:codex:acp:session-1",
        }),
        reason: "init-meta-failed",
      }),
    );
  });

  it("preempts an active turn on cancel and returns to idle state", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    let enteredRun = false;
    runtimeState.runTurn.mockImplementation(async function* (input: { signal?: AbortSignal }) {
      enteredRun = true;
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { stopReason: "cancel", type: "done" as const };
    });

    const manager = new AcpSessionManager();
    const runPromise = manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "run-1",
      sessionKey: "agent:codex:acp:session-1",
      text: "long task",
    });
    await vi.waitFor(() => {
      expect(enteredRun).toBe(true);
    });

    await manager.cancelSession({
      cfg: baseCfg,
      reason: "manual-cancel",
      sessionKey: "agent:codex:acp:session-1",
    });
    await runPromise;

    expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
    expect(runtimeState.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual-cancel",
      }),
    );
    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("idle");
    expect(states).not.toContain("error");
  });

  it("cleans actor-tail bookkeeping after session turns complete", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "done" as const };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey: "agent:codex:acp:session-a",
      text: "first",
    });
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r2",
      sessionKey: "agent:codex:acp:session-b",
      text: "second",
    });

    const internals = manager as unknown as {
      actorTailBySession: Map<string, Promise<void>>;
    };
    expect(internals.actorTailBySession.size).toBe(0);
  });

  it("surfaces backend failures raised after a done event", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "done" as const };
      throw new Error("acpx exited with code 1");
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        mode: "prompt",
        requestId: "run-1",
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "acpx exited with code 1",
    });

    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("error");
    expect(states.at(-1)).toBe("error");
  });

  it("marks the session as errored when runtime ensure fails before turn start", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockRejectedValue(new Error("acpx exited with code 1"));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: {
        ...readySessionMeta(),
        state: "running",
      },
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        mode: "prompt",
        requestId: "run-1",
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: "acpx exited with code 1",
    });

    const states = extractStatesFromUpserts();
    expect(states).not.toContain("running");
    expect(states.at(-1)).toBe("error");
  });

  it("retries once with a fresh runtime handle after an early acpx exit", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });
    runtimeState.runTurn
      .mockImplementationOnce(async function* () {
        yield {
          message: "acpx exited with code 1",
          type: "error" as const,
        };
      })
      .mockImplementationOnce(async function* () {
        yield { type: "done" as const };
      });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        mode: "prompt",
        requestId: "run-1",
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
      }),
    ).resolves.toBeUndefined();

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("idle");
    expect(states).not.toContain("error");
  });

  it("retries once with a fresh runtime handle after an early acpx signal exit", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });
    runtimeState.runTurn
      .mockImplementationOnce(async function* () {
        yield {
          message: "acpx exited with signal SIGTERM",
          type: "error" as const,
        };
      })
      .mockImplementationOnce(async function* () {
        yield { type: "done" as const };
      });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        mode: "prompt",
        requestId: "run-1",
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
      }),
    ).resolves.toBeUndefined();

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("idle");
    expect(states).not.toContain("error");
  });

  it("retries once with a fresh persistent session after an early missing-session turn failure", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:claude:acp:binding:discord:default:retry-no-session";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta({
        agent: "claude",
      }),
      identity: {
        acpxSessionId: "acpx-sid-stale",
        lastUpdatedAt: Date.now(),
        source: "status",
        state: "resolved",
      },
      runtimeSessionName: sessionKey,
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        acp: currentMeta,
        sessionKey: key,
        storeSessionKey: key,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        acp: currentMeta,
        sessionId: "session-1",
        updatedAt: Date.now(),
      };
    });
    runtimeState.ensureSession.mockImplementation(async (inputUnknown: unknown) => {
      const input = inputUnknown as {
        sessionKey: string;
        mode: "persistent" | "oneshot";
        resumeSessionId?: string;
      };
      return {
        backend: "acpx",
        backendSessionId: input.resumeSessionId ? "acpx-sid-stale" : "acpx-sid-fresh",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        sessionKey: input.sessionKey,
      };
    });
    runtimeState.getStatus.mockResolvedValue({
      backendSessionId: "acpx-sid-fresh",
      details: { status: "alive" },
      summary: "status=alive",
    });
    runtimeState.runTurn
      .mockImplementationOnce(async function* () {
        yield {
          code: "NO_SESSION",
          message:
            "Persistent ACP session acpx-sid-stale could not be resumed: Resource not found: acpx-sid-stale",
          type: "error" as const,
        };
      })
      .mockImplementationOnce(async function* () {
        yield { type: "done" as const };
      });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        mode: "prompt",
        requestId: "run-no-session",
        sessionKey,
        text: "do work",
      }),
    ).resolves.toBeUndefined();

    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey,
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.ensureSession.mock.calls[0]?.[0]).toMatchObject({
      resumeSessionId: "acpx-sid-stale",
      sessionKey,
    });
    const retryInput = runtimeState.ensureSession.mock.calls[1]?.[0] as
      | { resumeSessionId?: string }
      | undefined;
    expect(retryInput?.resumeSessionId).toBeUndefined();
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-sid-fresh");
    expect(currentMeta.identity?.state).toBe("resolved");
    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("idle");
    expect(states).not.toContain("error");
  });

  it("persists runtime mode changes through setSessionRuntimeMode", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    const manager = new AcpSessionManager();
    const options = await manager.setSessionRuntimeMode({
      cfg: baseCfg,
      runtimeMode: "plan",
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(runtimeState.setMode).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
      }),
    );
    expect(options.runtimeMode).toBe("plan");
    expect(extractRuntimeOptionsFromUpserts().some((entry) => entry?.runtimeMode === "plan")).toBe(
      true,
    );
  });

  it("reapplies persisted controls on next turn after runtime option updates", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeOptions: {
        runtimeMode: "plan",
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        acp: currentMeta,
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        acp: currentMeta,
        sessionId: "session-1",
        updatedAt: Date.now(),
      };
    });

    const manager = new AcpSessionManager();
    await manager.setSessionConfigOption({
      cfg: baseCfg,
      key: "model",
      sessionKey: "agent:codex:acp:session-1",
      value: "openai-codex/gpt-5.4",
    });
    expect(runtimeState.setMode).not.toHaveBeenCalled();

    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "run-1",
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
    });

    expect(runtimeState.setMode).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
      }),
    );
  });

  it("reconciles persisted ACP session identifiers from runtime status after a turn", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      agentSessionId: "agent-stale",
      backend: "acpx",
      backendSessionId: "acpx-stale",
      runtimeSessionName: "runtime-1",
      sessionKey: "agent:codex:acp:session-1",
    });
    runtimeState.getStatus.mockResolvedValue({
      agentSessionId: "agent-fresh",
      backendSessionId: "acpx-fresh",
      details: { status: "alive" },
      summary: "status=alive",
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        acpxSessionId: "acpx-stale",
        agentSessionId: "agent-stale",
        lastUpdatedAt: Date.now(),
        source: "status",
        state: "resolved",
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        acp: currentMeta,
        sessionKey,
        storeSessionKey: sessionKey,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        acp: currentMeta,
        sessionId: "session-1",
        updatedAt: Date.now(),
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "run-1",
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
    });

    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-fresh");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-fresh");
  });

  it("reconciles pending ACP identities during startup scan", async () => {
    const runtimeState = createRuntime();
    runtimeState.getStatus.mockResolvedValue({
      acpxRecordId: "acpx-record-1",
      agentSessionId: "agent-session-1",
      backendSessionId: "acpx-session-1",
      details: { status: "alive" },
      summary: "status=alive",
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        acpxSessionId: "acpx-stale",
        lastUpdatedAt: Date.now(),
        source: "ensure",
        state: "pending",
      },
    };
    const sessionKey = "agent:codex:acp:session-1";
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        acp: currentMeta,
        cfg: baseCfg,
        entry: {
          acp: currentMeta,
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        sessionKey,
        storePath: "/tmp/sessions-acp.json",
        storeSessionKey: sessionKey,
      },
    ]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        acp: currentMeta,
        sessionKey: key,
        storeSessionKey: key,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        acp: currentMeta,
        sessionId: "session-1",
        updatedAt: Date.now(),
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 1, failed: 0, resolved: 1 });
    expect(currentMeta.identity?.state).toBe("resolved");
    expect(currentMeta.identity?.acpxRecordId).toBe("acpx-record-1");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-session-1");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-session-1");
  });

  it("skips startup reconcile for pending identities without stable runtime ids", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        acp: {
          ...readySessionMeta({
            agent: "claude",
          }),
          identity: {
            acpxRecordId: sessionKey,
            lastUpdatedAt: Date.now(),
            source: "status",
            state: "pending",
          },
        },
        cfg: baseCfg,
        entry: {
          acp: {
            ...readySessionMeta({
              agent: "claude",
            }),
            identity: {
              acpxRecordId: sessionKey,
              lastUpdatedAt: Date.now(),
              source: "status",
              state: "pending",
            },
          },
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        sessionKey,
        storePath: "/tmp/sessions-acp.json",
        storeSessionKey: sessionKey,
      },
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, failed: 0, resolved: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
  });

  it("reconciles prompt-learned agent session IDs even when runtime status omits them", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      backend: "acpx",
      backendSessionId: "acpx-stale",
      runtimeSessionName: "runtime-3",
      sessionKey: "agent:gemini:acp:session-1",
    });
    runtimeState.runTurn.mockImplementation(async function* (inputUnknown: unknown) {
      const input = inputUnknown as {
        handle: {
          agentSessionId?: string;
        };
      };
      input.handle.agentSessionId = "gemini-session-1";
      yield { type: "done" as const };
    });
    runtimeState.getStatus.mockResolvedValue({
      details: { status: "alive" },
      summary: "status=alive",
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      agent: "gemini",
      identity: {
        acpxSessionId: "acpx-stale",
        lastUpdatedAt: Date.now(),
        source: "ensure",
        state: "pending",
      },
    };
    const sessionKey = "agent:gemini:acp:session-1";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        acp: currentMeta,
        sessionKey: key,
        storeSessionKey: key,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        acp: currentMeta,
        sessionId: "session-1",
        updatedAt: Date.now(),
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "run-prompt-learned-agent-id",
      sessionKey,
      text: "learn prompt session",
    });

    expect(currentMeta.identity?.state).toBe("resolved");
    expect(currentMeta.identity?.agentSessionId).toBe("gemini-session-1");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-stale");
  });

  it("skips startup identity reconciliation for already resolved sessions", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:session-1";
    const resolvedMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "agent-sid-1",
        lastUpdatedAt: Date.now(),
        source: "status",
        state: "resolved",
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        acp: resolvedMeta,
        cfg: baseCfg,
        entry: {
          acp: resolvedMeta,
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        sessionKey,
        storePath: "/tmp/sessions-acp.json",
        storeSessionKey: sessionKey,
      },
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, failed: 0, resolved: 0 });
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
  });

  it("preserves existing ACP session identifiers when ensure returns none", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      backend: "acpx",
      runtimeSessionName: "runtime-2",
      sessionKey: "agent:codex:acp:session-1",
    });
    runtimeState.getStatus.mockResolvedValue({
      details: { status: "alive" },
      summary: "status=alive",
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: {
        ...readySessionMeta(),
        identity: {
          acpxSessionId: "acpx-stable",
          agentSessionId: "agent-stable",
          lastUpdatedAt: Date.now(),
          source: "status",
          state: "resolved",
        },
      },
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    const manager = new AcpSessionManager();
    const status = await manager.getSessionStatus({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(status.identity?.acpxSessionId).toBe("acpx-stable");
    expect(status.identity?.agentSessionId).toBe("agent-stable");
  });

  it("applies persisted runtime options before running turns", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: {
        ...readySessionMeta(),
        runtimeOptions: {
          model: "openai-codex/gpt-5.4",
          permissionProfile: "strict",
          runtimeMode: "plan",
          timeoutSeconds: 120,
        },
      },
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "run-1",
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
    });

    expect(runtimeState.setMode).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
      }),
    );
    expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "model",
        value: "openai-codex/gpt-5.4",
      }),
    );
    expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "approval_policy",
        value: "strict",
      }),
    );
    expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "timeout",
        value: "120",
      }),
    );
  });

  it("re-ensures runtime handles after cwd runtime option updates", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:session-cwd-update";
    let currentEntry = {
      acp: readySessionMeta(),
      sessionKey,
      storeSessionKey: sessionKey,
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => currentEntry);
    hoisted.upsertAcpSessionMetaMock.mockImplementation((paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const nextMeta = params.mutate(currentEntry.acp, currentEntry);
      if (nextMeta === null) {
        return null;
      }
      currentEntry = {
        ...currentEntry,
        acp: nextMeta ?? currentEntry.acp,
      };
      return currentEntry;
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r1",
      sessionKey,
      text: "first",
    });

    await expect(
      manager.updateSessionRuntimeOptions({
        cfg: baseCfg,
        patch: { cwd: "/workspace/next" },
        sessionKey,
      }),
    ).resolves.toEqual({
      cwd: "/workspace/next",
    });

    expect(currentEntry.acp.runtimeOptions).toEqual({
      cwd: "/workspace/next",
    });
    expect(currentEntry.acp.cwd).toBe("/workspace/next");

    await manager.runTurn({
      cfg: baseCfg,
      mode: "prompt",
      requestId: "r2",
      sessionKey,
      text: "second",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.ensureSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: "/workspace/next",
        sessionKey,
      }),
    );
  });

  it("returns unsupported-control error when backend does not support set_config_option", async () => {
    const runtimeState = createRuntime();
    const unsupportedRuntime: AcpRuntime = {
      cancel: runtimeState.cancel as AcpRuntime["cancel"],
      close: runtimeState.close as AcpRuntime["close"],
      ensureSession: runtimeState.ensureSession as AcpRuntime["ensureSession"],
      getCapabilities: vi.fn(async () => ({ controls: [] })),
      runTurn: runtimeState.runTurn as AcpRuntime["runTurn"],
    };
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: unsupportedRuntime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.setSessionConfigOption({
        cfg: baseCfg,
        key: "model",
        sessionKey: "agent:codex:acp:session-1",
        value: "gpt-5.4",
      }),
    ).rejects.toMatchObject({
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
    });
  });

  it("rejects invalid runtime option values before backend controls run", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.setSessionConfigOption({
        cfg: baseCfg,
        key: "timeout",
        sessionKey: "agent:codex:acp:session-1",
        value: "not-a-number",
      }),
    ).rejects.toMatchObject({
      code: "ACP_INVALID_RUNTIME_OPTION",
    });
    expect(runtimeState.setConfigOption).not.toHaveBeenCalled();

    await expect(
      manager.updateSessionRuntimeOptions({
        cfg: baseCfg,
        patch: { cwd: "relative/path" },
        sessionKey: "agent:codex:acp:session-1",
      }),
    ).rejects.toMatchObject({
      code: "ACP_INVALID_RUNTIME_OPTION",
    });
  });

  it("can close and clear metadata when backend is unavailable", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      allowBackendUnavailable: true,
      cfg: baseCfg,
      clearMeta: true,
      reason: "manual-close",
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toContain("not configured");
    expect(result.metaCleared).toBe(true);
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalled();
  });

  it("does not fail reset close recovery when backend lookup also throws", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      allowBackendUnavailable: true,
      cfg: baseCfg,
      clearMeta: false,
      discardPersistentState: true,
      reason: "new-in-place-reset",
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toContain("not configured");
    expect(result.metaCleared).toBe(false);
  });

  it("prepares a fresh session during reset recovery even when the backend is unhealthy", async () => {
    const runtimeState = createRuntime();
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta({
        agent: "claude",
      }),
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        "ACP runtime backend is currently unavailable. Try again in a moment.",
      );
    });
    hoisted.getAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      allowBackendUnavailable: true,
      cfg: baseCfg,
      clearMeta: false,
      discardPersistentState: true,
      reason: "new-in-place-reset",
      sessionKey: "agent:claude:acp:session-1",
    });

    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toContain("currently unavailable");
    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey: "agent:claude:acp:session-1",
    });
  });

  it("surfaces metadata clear errors during closeSession", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: readySessionMeta(),
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk locked"));

    const manager = new AcpSessionManager();
    await expect(
      manager.closeSession({
        allowBackendUnavailable: true,
        cfg: baseCfg,
        clearMeta: true,
        reason: "manual-close",
        sessionKey: "agent:codex:acp:session-1",
      }),
    ).rejects.toThrow("disk locked");
  });
});
