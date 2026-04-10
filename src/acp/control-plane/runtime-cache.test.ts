import { describe, expect, it, vi } from "vitest";
import type { AcpRuntime } from "../runtime/types.js";
import type { AcpRuntimeHandle } from "../runtime/types.js";
import type { CachedRuntimeState } from "./runtime-cache.js";
import { RuntimeCache } from "./runtime-cache.js";

function mockState(sessionKey: string): CachedRuntimeState {
  const runtime = {
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ensureSession: vi.fn(async () => ({
      backend: "acpx",
      runtimeSessionName: `runtime:${sessionKey}`,
      sessionKey,
    })),
    runTurn: vi.fn(async function* runTurn() {
      yield { type: "done" as const };
    }),
  } as unknown as AcpRuntime;
  return {
    agent: "codex",
    backend: "acpx",
    handle: {
      backend: "acpx",
      runtimeSessionName: `runtime:${sessionKey}`,
      sessionKey,
    } as AcpRuntimeHandle,
    mode: "persistent",
    runtime,
  };
}

describe("RuntimeCache", () => {
  it("tracks idle candidates with touch-aware lookups", () => {
    vi.useFakeTimers();
    try {
      const cache = new RuntimeCache();
      const actor = "agent:codex:acp:s1";
      cache.set(actor, mockState(actor), { now: 1000 });

      expect(cache.collectIdleCandidates({ maxIdleMs: 1000, now: 1999 })).toHaveLength(0);
      expect(cache.collectIdleCandidates({ maxIdleMs: 1000, now: 2000 })).toHaveLength(1);

      cache.get(actor, { now: 2500 });
      expect(cache.collectIdleCandidates({ maxIdleMs: 1000, now: 3200 })).toHaveLength(0);
      expect(cache.collectIdleCandidates({ maxIdleMs: 1000, now: 3500 })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns snapshot entries with idle durations", () => {
    const cache = new RuntimeCache();
    cache.set("a", mockState("a"), { now: 10 });
    cache.set("b", mockState("b"), { now: 100 });

    const snapshot = cache.snapshot({ now: 1100 });
    const byActor = new Map(snapshot.map((entry) => [entry.actorKey, entry]));
    expect(byActor.get("a")?.idleMs).toBe(1090);
    expect(byActor.get("b")?.idleMs).toBe(1000);
  });
});
