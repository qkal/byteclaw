import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readCompactionCount,
  seedSessionStore,
  waitForCompactionCount,
} from "./pi-embedded-subscribe.compaction-test-helpers.js";
import {
  handleAutoCompactionEnd,
  reconcileSessionStoreCompactionCountAfterSuccess,
} from "./pi-embedded-subscribe.handlers.compaction.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

function createCompactionContext(params: {
  storePath: string;
  sessionKey: string;
  agentId?: string;
  initialCount: number;
}): EmbeddedPiSubscribeContext {
  let compactionCount = params.initialCount;
  return {
    ensureCompactionPromise: vi.fn(),
    getCompactionCount: () => compactionCount,
    incrementCompactionCount: () => {
      compactionCount += 1;
    },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    maybeResolveCompactionWait: vi.fn(),
    noteCompactionRetry: vi.fn(),
    params: {
      agentId: params.agentId ?? "test-agent",
      config: { session: { store: params.storePath } } as never,
      onAgentEvent: undefined,
      runId: "run-test",
      session: { messages: [] } as never,
      sessionId: "session-1",
      sessionKey: params.sessionKey,
    },
    resetForCompactionRetry: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    state: {
      compactionInFlight: true,
      pendingCompactionRetry: 0,
    } as never,
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("reconcileSessionStoreCompactionCountAfterSuccess", () => {
  it("raises the stored compaction count to the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-reconcile-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      compactionCount: 1,
      sessionKey,
      storePath,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      agentId: "test-agent",
      configStore: storePath,
      now: 2000,
      observedCompactionCount: 2,
      sessionKey,
    });

    expect(nextCount).toBe(2);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
  });

  it("does not double count when the store is already at or above the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-idempotent-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      compactionCount: 3,
      sessionKey,
      storePath,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      agentId: "test-agent",
      configStore: storePath,
      now: 2000,
      observedCompactionCount: 2,
      sessionKey,
    });

    expect(nextCount).toBe(3);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(3);
  });
});

describe("handleAutoCompactionEnd", () => {
  it("reconciles the session store after a successful compaction end event", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-handler-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      compactionCount: 1,
      sessionKey,
      storePath,
    });

    const ctx = createCompactionContext({
      initialCount: 1,
      sessionKey,
      storePath,
    });

    handleAutoCompactionEnd(ctx, {
      aborted: false,
      result: { kept: 12 },
      type: "auto_compaction_end",
      willRetry: false,
    } as never);

    await waitForCompactionCount({
      expected: 2,
      sessionKey,
      storePath,
    });

    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
  });
});
