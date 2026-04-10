import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySessionStore } from "./session.js";

describe("acp session manager", () => {
  let nowMs = 0;
  const now = () => nowMs;
  const advance = (ms: number) => {
    nowMs += ms;
  };
  let store = createInMemorySessionStore({ now });

  beforeEach(() => {
    nowMs = 1000;
    store = createInMemorySessionStore({ now });
  });

  afterEach(() => {
    store.clearAllSessionsForTest();
  });

  it("tracks active runs and clears on cancel", () => {
    const session = store.createSession({
      cwd: "/tmp",
      sessionKey: "acp:test",
    });
    const controller = new AbortController();
    store.setActiveRun(session.sessionId, "run-1", controller);

    expect(store.getSessionByRunId("run-1")?.sessionId).toBe(session.sessionId);

    const cancelled = store.cancelActiveRun(session.sessionId);
    expect(cancelled).toBe(true);
    expect(store.getSessionByRunId("run-1")).toBeUndefined();
  });

  it("refreshes existing session IDs instead of creating duplicates", () => {
    const first = store.createSession({
      cwd: "/tmp/one",
      sessionId: "existing",
      sessionKey: "acp:one",
    });
    advance(500);

    const refreshed = store.createSession({
      cwd: "/tmp/two",
      sessionId: "existing",
      sessionKey: "acp:two",
    });

    expect(refreshed).toBe(first);
    expect(refreshed.sessionKey).toBe("acp:two");
    expect(refreshed.cwd).toBe("/tmp/two");
    expect(refreshed.createdAt).toBe(1000);
    expect(refreshed.lastTouchedAt).toBe(1500);
    expect(store.hasSession("existing")).toBe(true);
  });

  it("reaps idle sessions before enforcing the max session cap", () => {
    const boundedStore = createInMemorySessionStore({
      idleTtlMs: 1000,
      maxSessions: 1,
      now,
    });
    try {
      boundedStore.createSession({
        cwd: "/tmp",
        sessionId: "old",
        sessionKey: "acp:old",
      });
      advance(2000);
      const fresh = boundedStore.createSession({
        cwd: "/tmp",
        sessionId: "fresh",
        sessionKey: "acp:fresh",
      });

      expect(fresh.sessionId).toBe("fresh");
      expect(boundedStore.getSession("old")).toBeUndefined();
      expect(boundedStore.hasSession("old")).toBe(false);
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });

  it("uses soft-cap eviction for the oldest idle session when full", () => {
    const boundedStore = createInMemorySessionStore({
      idleTtlMs: 24 * 60 * 60 * 1000,
      maxSessions: 2,
      now,
    });
    try {
      const first = boundedStore.createSession({
        cwd: "/tmp",
        sessionId: "first",
        sessionKey: "acp:first",
      });
      advance(100);
      const second = boundedStore.createSession({
        cwd: "/tmp",
        sessionId: "second",
        sessionKey: "acp:second",
      });
      const controller = new AbortController();
      boundedStore.setActiveRun(second.sessionId, "run-2", controller);
      advance(100);

      const third = boundedStore.createSession({
        cwd: "/tmp",
        sessionId: "third",
        sessionKey: "acp:third",
      });

      expect(third.sessionId).toBe("third");
      expect(boundedStore.getSession(first.sessionId)).toBeUndefined();
      expect(boundedStore.getSession(second.sessionId)).toBeDefined();
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });

  it("rejects when full and no session is evictable", () => {
    const boundedStore = createInMemorySessionStore({
      idleTtlMs: 24 * 60 * 60 * 1000,
      maxSessions: 1,
      now,
    });
    try {
      const only = boundedStore.createSession({
        cwd: "/tmp",
        sessionId: "only",
        sessionKey: "acp:only",
      });
      boundedStore.setActiveRun(only.sessionId, "run-only", new AbortController());

      expect(() =>
        boundedStore.createSession({
          cwd: "/tmp",
          sessionId: "next",
          sessionKey: "acp:next",
        }),
      ).toThrow(/session limit reached/i);
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });
});
