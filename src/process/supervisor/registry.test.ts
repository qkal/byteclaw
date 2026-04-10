import { describe, expect, it } from "vitest";
import { createRunRegistry } from "./registry.js";

type RunRegistry = ReturnType<typeof createRunRegistry>;

function addRunningRecord(
  registry: RunRegistry,
  params: {
    runId: string;
    sessionId: string;
    startedAtMs: number;
    scopeKey?: string;
    backendId?: string;
  },
) {
  registry.add({
    backendId: params.backendId ?? "b1",
    createdAtMs: params.startedAtMs,
    lastOutputAtMs: params.startedAtMs,
    runId: params.runId,
    scopeKey: params.scopeKey,
    sessionId: params.sessionId,
    startedAtMs: params.startedAtMs,
    state: "running",
    updatedAtMs: params.startedAtMs,
  });
}

describe("process supervisor run registry", () => {
  it("finalize is idempotent and preserves first terminal metadata", () => {
    const registry = createRunRegistry();
    addRunningRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });

    const first = registry.finalize("r1", {
      exitCode: null,
      exitSignal: "SIGKILL",
      reason: "overall-timeout",
    });
    const second = registry.finalize("r1", {
      exitCode: 0,
      exitSignal: null,
      reason: "manual-cancel",
    });

    expect(first).not.toBeNull();
    expect(first?.firstFinalize).toBe(true);
    expect(first?.record.terminationReason).toBe("overall-timeout");
    expect(first?.record.exitCode).toBeNull();
    expect(first?.record.exitSignal).toBe("SIGKILL");

    expect(second).not.toBeNull();
    expect(second?.firstFinalize).toBe(false);
    expect(second?.record.terminationReason).toBe("overall-timeout");
    expect(second?.record.exitCode).toBeNull();
    expect(second?.record.exitSignal).toBe("SIGKILL");
  });

  it("prunes oldest exited records once retention cap is exceeded", () => {
    const registry = createRunRegistry({ maxExitedRecords: 2 });
    addRunningRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });
    addRunningRecord(registry, { runId: "r2", sessionId: "s2", startedAtMs: 2 });
    addRunningRecord(registry, { runId: "r3", sessionId: "s3", startedAtMs: 3 });

    registry.finalize("r1", { exitCode: 0, exitSignal: null, reason: "exit" });
    registry.finalize("r2", { exitCode: 0, exitSignal: null, reason: "exit" });
    registry.finalize("r3", { exitCode: 0, exitSignal: null, reason: "exit" });

    expect(registry.get("r1")).toBeUndefined();
    expect(registry.get("r2")?.state).toBe("exited");
    expect(registry.get("r3")?.state).toBe("exited");
  });

  it("filters listByScope and returns detached copies", () => {
    const registry = createRunRegistry();
    addRunningRecord(registry, {
      runId: "r1",
      scopeKey: "scope:a",
      sessionId: "s1",
      startedAtMs: 1,
    });
    addRunningRecord(registry, {
      runId: "r2",
      scopeKey: "scope:b",
      sessionId: "s2",
      startedAtMs: 2,
    });

    expect(registry.listByScope("   ")).toEqual([]);
    const scoped = registry.listByScope("scope:a");
    expect(scoped).toHaveLength(1);
    const [firstScoped] = scoped;
    expect(firstScoped?.runId).toBe("r1");

    if (!firstScoped) {
      throw new Error("missing scoped record");
    }
    firstScoped.state = "exited";
    expect(registry.get("r1")?.state).toBe("running");
  });
});
