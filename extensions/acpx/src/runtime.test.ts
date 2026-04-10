import type { AcpSessionStore } from "acpx/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntime } from "../runtime-api.js";
import { AcpxRuntime } from "./runtime.js";

function makeRuntime(baseStore: AcpSessionStore): {
  runtime: AcpxRuntime;
  wrappedStore: AcpSessionStore & { markFresh: (sessionKey: string) => void };
  delegate: { close: AcpRuntime["close"] };
} {
  const runtime = new AcpxRuntime({
    agentRegistry: {
      list: () => ["codex"],
      resolve: () => "codex",
    },
    cwd: "/tmp",
    permissionMode: "approve-reads",
    sessionStore: baseStore,
  });

  return {
    delegate: (runtime as unknown as { delegate: { close: AcpRuntime["close"] } }).delegate,
    runtime,
    wrappedStore: (
      runtime as unknown as {
        sessionStore: AcpSessionStore & { markFresh: (sessionKey: string) => void };
      }
    ).sessionStore,
  };
}

describe("AcpxRuntime fresh reset wrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps stale persistent loads hidden until a fresh record is saved", async () => {
    const baseStore: AcpSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore } = makeRuntime(baseStore);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await runtime.prepareFreshSession({
      sessionKey: "agent:codex:acp:binding:test",
    });

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await wrappedStore.save({
      acpxRecordId: "fresh-record",
      name: "agent:codex:acp:binding:test",
    } as never);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(2);
  });

  it("marks the session fresh after discardPersistentState close", async () => {
    const baseStore: AcpSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore);
    const close = vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      discardPersistentState: true,
      handle: {
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
        sessionKey: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
    });

    expect(close).toHaveBeenCalledWith({
      discardPersistentState: true,
      handle: {
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
        sessionKey: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
    });
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).not.toHaveBeenCalled();
  });
});
