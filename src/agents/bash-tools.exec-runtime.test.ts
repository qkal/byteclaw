import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requestHeartbeatNowMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: requestHeartbeatNowMock,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));

let buildExecExitOutcome: typeof import("./bash-tools.exec-runtime.js").buildExecExitOutcome;
let detectCursorKeyMode: typeof import("./bash-tools.exec-runtime.js").detectCursorKeyMode;
let emitExecSystemEvent: typeof import("./bash-tools.exec-runtime.js").emitExecSystemEvent;
let formatExecFailureReason: typeof import("./bash-tools.exec-runtime.js").formatExecFailureReason;
let resolveExecTarget: typeof import("./bash-tools.exec-runtime.js").resolveExecTarget;

beforeAll(async () => {
  ({
    buildExecExitOutcome,
    detectCursorKeyMode,
    emitExecSystemEvent,
    formatExecFailureReason,
    resolveExecTarget,
  } = await import("./bash-tools.exec-runtime.js"));
});

describe("detectCursorKeyMode", () => {
  it("returns null when no toggle found", () => {
    expect(detectCursorKeyMode("hello world")).toBe(null);
    expect(detectCursorKeyMode("")).toBe(null);
  });

  it("detects smkx (application mode)", () => {
    expect(detectCursorKeyMode("\x1b[?1h")).toBe("application");
    expect(detectCursorKeyMode("\x1b[?1h\x1b=")).toBe("application");
    expect(detectCursorKeyMode("before \x1b[?1h after")).toBe("application");
  });

  it("detects rmkx (normal mode)", () => {
    expect(detectCursorKeyMode("\x1b[?1l")).toBe("normal");
    expect(detectCursorKeyMode("\x1b[?1l\x1b>")).toBe("normal");
    expect(detectCursorKeyMode("before \x1b[?1l after")).toBe("normal");
  });

  it("last toggle wins when both present", () => {
    // Smkx first, then rmkx - should be normal
    expect(detectCursorKeyMode("\x1b[?1h\x1b[?1l")).toBe("normal");
    // Rmkx first, then smkx - should be application
    expect(detectCursorKeyMode("\x1b[?1l\x1b[?1h")).toBe("application");
    // Multiple toggles - last one wins
    expect(detectCursorKeyMode("\x1b[?1h\x1b[?1l\x1b[?1h")).toBe("application");
  });
});

describe("resolveExecTarget", () => {
  it("keeps implicit auto on sandbox when a sandbox runtime is available", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      effectiveHost: "sandbox",
      requestedTarget: null,
      selectedTarget: "auto",
    });
  });

  it("keeps implicit auto on gateway when no sandbox runtime is available", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      effectiveHost: "gateway",
      requestedTarget: null,
      selectedTarget: "auto",
    });
  });

  it("allows per-call host=node override when configured host is auto", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        requestedTarget: "node",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      effectiveHost: "node",
      requestedTarget: "node",
      selectedTarget: "node",
    });
  });

  it("allows per-call host=gateway override when configured host is auto and no sandbox", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        requestedTarget: "gateway",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      effectiveHost: "gateway",
      requestedTarget: "gateway",
      selectedTarget: "gateway",
    });
  });

  it("rejects per-call host=gateway override from auto when sandbox is available", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        requestedTarget: "gateway",
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is auto; set tools.exec.host=gateway or auto to allow this override).",
    );
  });

  it("allows per-call host=sandbox override when configured host is auto", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        requestedTarget: "sandbox",
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      effectiveHost: "sandbox",
      requestedTarget: "sandbox",
      selectedTarget: "sandbox",
    });
  });

  it("rejects cross-host override when configured target is a concrete host", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "node",
        elevatedRequested: false,
        requestedTarget: "gateway",
        sandboxAvailable: false,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    );
  });

  it("allows explicit auto request when configured host is auto", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        requestedTarget: "auto",
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      effectiveHost: "sandbox",
      requestedTarget: "auto",
      selectedTarget: "auto",
    });
  });

  it("requires an exact match for non-auto configured targets", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "gateway",
        elevatedRequested: false,
        requestedTarget: "auto",
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested auto; configured host is gateway; set tools.exec.host=auto to allow this override).",
    );
  });

  it("allows exact node matches", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "node",
        elevatedRequested: false,
        requestedTarget: "node",
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      configuredTarget: "node",
      effectiveHost: "node",
      requestedTarget: "node",
      selectedTarget: "node",
    });
  });

  it("forces elevated requests onto the gateway host when configured target is auto", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: true,
        requestedTarget: "sandbox",
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      effectiveHost: "gateway",
      requestedTarget: "sandbox",
      selectedTarget: "gateway",
    });
  });

  it("keeps explicit node override under elevated requests when configured target is auto", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: true,
        requestedTarget: "node",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      effectiveHost: "node",
      requestedTarget: "node",
      selectedTarget: "node",
    });
  });

  it("honours node target for elevated requests when configured target is node", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "node",
        elevatedRequested: true,
        requestedTarget: "node",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      configuredTarget: "node",
      effectiveHost: "node",
      requestedTarget: "node",
      selectedTarget: "node",
    });
  });

  it("routes to node for elevated when configured=node and no per-call override", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "node",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      configuredTarget: "node",
      effectiveHost: "node",
      requestedTarget: null,
      selectedTarget: "node",
    });
  });

  it("rejects mismatched requestedTarget under elevated+node", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "node",
        elevatedRequested: true,
        requestedTarget: "gateway",
        sandboxAvailable: false,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    );
  });
});

describe("emitExecSystemEvent", () => {
  beforeEach(() => {
    requestHeartbeatNowMock.mockClear();
    enqueueSystemEventMock.mockClear();
  });

  it("scopes heartbeat wake to the event session key", () => {
    emitExecSystemEvent("Exec finished", {
      contextKey: "exec:run-1",
      sessionKey: "agent:ops:main",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      contextKey: "exec:run-1",
      sessionKey: "agent:ops:main",
    });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "exec-event",
      sessionKey: "agent:ops:main",
    });
  });

  it("keeps wake unscoped for non-agent session keys", () => {
    emitExecSystemEvent("Exec finished", {
      contextKey: "exec:run-global",
      sessionKey: "global",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      contextKey: "exec:run-global",
      sessionKey: "global",
    });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "exec-event",
    });
  });

  it("ignores events without a session key", () => {
    emitExecSystemEvent("Exec finished", {
      contextKey: "exec:run-2",
      sessionKey: "  ",
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });
});

describe("formatExecFailureReason", () => {
  it("formats timeout guidance with the configured timeout", () => {
    expect(
      formatExecFailureReason({
        exitSignal: "SIGKILL",
        failureKind: "overall-timeout",
        timeoutSec: 45,
      }),
    ).toContain("45 seconds");
  });

  it("points long-running work to registered exec backgrounding", () => {
    const reason = formatExecFailureReason({
      exitSignal: "SIGKILL",
      failureKind: "overall-timeout",
      timeoutSec: 45,
    });

    expect(reason).toContain("background=true");
    expect(reason).toContain("yieldMs");
    expect(reason).toContain("Do not rely on shell backgrounding");
  });

  it("formats shell failures without timeout-specific guidance", () => {
    expect(
      formatExecFailureReason({
        exitSignal: null,
        failureKind: "shell-command-not-found",
        timeoutSec: 45,
      }),
    ).toBe("Command not found");
  });
});

describe("buildExecExitOutcome", () => {
  it("keeps non-zero normal exits in the completed path", () => {
    expect(
      buildExecExitOutcome({
        aggregated: "done",
        durationMs: 123,
        exit: {
          durationMs: 123,
          exitCode: 1,
          exitSignal: null,
          noOutputTimedOut: false,
          reason: "exit",
          stderr: "",
          stdout: "",
          timedOut: false,
        },
        timeoutSec: 30,
      }),
    ).toMatchObject({
      aggregated: "done\n\n(Command exited with code 1)",
      exitCode: 1,
      status: "completed",
    });
  });

  it("classifies timed out exits as failures with a reason", () => {
    expect(
      buildExecExitOutcome({
        aggregated: "",
        durationMs: 123,
        exit: {
          durationMs: 123,
          exitCode: null,
          exitSignal: "SIGKILL",
          noOutputTimedOut: false,
          reason: "overall-timeout",
          stderr: "",
          stdout: "",
          timedOut: true,
        },
        timeoutSec: 30,
      }),
    ).toMatchObject({
      failureKind: "overall-timeout",
      reason: expect.stringContaining("30 seconds"),
      status: "failed",
      timedOut: true,
    });
  });

  it("keeps timed out shell-backgrounded commands on the failed path", () => {
    const outcome = buildExecExitOutcome({
      aggregated: "started worker",
      durationMs: 123,
      exit: {
        durationMs: 123,
        exitCode: null,
        exitSignal: "SIGKILL",
        noOutputTimedOut: false,
        reason: "overall-timeout",
        stderr: "",
        stdout: "",
        timedOut: true,
      },
      timeoutSec: 30,
    });

    if (outcome.status !== "failed") {
      throw new Error(`Expected timeout to fail, got ${outcome.status}`);
    }
    expect(outcome).toMatchObject({ failureKind: "overall-timeout", timedOut: true });
    expect(outcome.reason).toContain("background=true");
    expect(outcome.reason).toContain("Do not rely on shell backgrounding");
  });
});
