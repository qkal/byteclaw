import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearAgentRunContext,
  emitAgentEvent,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
  resetAgentEventsForTest,
  resetAgentRunContextForTest,
  sweepStaleRunContexts,
} from "./agent-events.js";

type AgentEventsModule = typeof import("./agent-events.js");

const agentEventsModuleUrl = new URL("agent-events.ts", import.meta.url).href;

async function importAgentEventsModule(cacheBust: string): Promise<AgentEventsModule> {
  return (await import(`${agentEventsModuleUrl}?t=${cacheBust}`)) as AgentEventsModule;
}

describe("agent-events sequencing", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  test("stores and clears run context", async () => {
    registerAgentRunContext("run-1", { sessionKey: "main" });
    expect(getAgentRunContext("run-1")?.sessionKey).toBe("main");
    clearAgentRunContext("run-1");
    expect(getAgentRunContext("run-1")).toBeUndefined();
  });

  test("maintains monotonic seq per runId", async () => {
    const seen: Record<string, number[]> = {};
    const stop = onAgentEvent((evt) => {
      const list = seen[evt.runId] ?? [];
      seen[evt.runId] = list;
      list.push(evt.seq);
    });

    emitAgentEvent({ data: {}, runId: "run-1", stream: "lifecycle" });
    emitAgentEvent({ data: {}, runId: "run-1", stream: "lifecycle" });
    emitAgentEvent({ data: {}, runId: "run-2", stream: "lifecycle" });
    emitAgentEvent({ data: {}, runId: "run-1", stream: "lifecycle" });

    stop();

    expect(seen["run-1"]).toEqual([1, 2, 3]);
    expect(seen["run-2"]).toEqual([1]);
  });

  test("preserves compaction ordering on the event bus", async () => {
    const phases: string[] = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-1") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    emitAgentEvent({ data: { phase: "start" }, runId: "run-1", stream: "compaction" });
    emitAgentEvent({
      data: { phase: "end", willRetry: false },
      runId: "run-1",
      stream: "compaction",
    });

    stop();

    expect(phases).toEqual(["start", "end"]);
  });

  test("omits sessionKey for runs hidden from Control UI", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-hidden", {
      isControlUiVisible: false,
      sessionKey: "session-imessage",
    });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      data: { text: "hi" },
      runId: "run-hidden",
      sessionKey: "session-imessage",
      stream: "assistant",
    });
    stop();

    expect(receivedSessionKey).toBeUndefined();
  });

  test("merges later run context updates into existing runs", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-ctx", {
      isControlUiVisible: true,
      sessionKey: "session-main",
    });
    registerAgentRunContext("run-ctx", {
      isHeartbeat: true,
      verboseLevel: "full",
    });

    expect(getAgentRunContext("run-ctx")).toMatchObject({
      isControlUiVisible: true,
      isHeartbeat: true,
      sessionKey: "session-main",
      verboseLevel: "full",
    });
  });

  test("falls back to registered sessionKey when event sessionKey is blank", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-ctx", { sessionKey: "session-main" });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      data: { text: "hi" },
      runId: "run-ctx",
      sessionKey: "   ",
      stream: "assistant",
    });
    stop();

    expect(receivedSessionKey).toBe("session-main");
  });

  test("keeps notifying later listeners when one throws", async () => {
    const seen: string[] = [];
    const stopBad = onAgentEvent(() => {
      throw new Error("boom");
    });
    const stopGood = onAgentEvent((evt) => {
      seen.push(evt.runId);
    });

    expect(() =>
      emitAgentEvent({
        data: { text: "hi" },
        runId: "run-safe",
        stream: "assistant",
      }),
    ).not.toThrow();

    stopGood();
    stopBad();

    expect(seen).toEqual(["run-safe"]);
  });

  test("shares run context, listeners, and sequence state across duplicate module instances", async () => {
    const first = await importAgentEventsModule(`first-${Date.now()}`);
    const second = await importAgentEventsModule(`second-${Date.now()}`);

    first.resetAgentEventsForTest();
    first.registerAgentRunContext("run-dup", { sessionKey: "session-dup" });

    const seen: { seq: number; sessionKey?: string }[] = [];
    const stop = first.onAgentEvent((evt) => {
      if (evt.runId === "run-dup") {
        seen.push({ seq: evt.seq, sessionKey: evt.sessionKey });
      }
    });

    second.emitAgentEvent({
      data: { text: "from second" },
      runId: "run-dup",
      sessionKey: "   ",
      stream: "assistant",
    });
    first.emitAgentEvent({
      data: { text: "from first" },
      runId: "run-dup",
      sessionKey: "   ",
      stream: "assistant",
    });

    stop();

    expect(second.getAgentRunContext("run-dup")).toMatchObject({ sessionKey: "session-dup" });
    expect(seen).toEqual([
      { seq: 1, sessionKey: "session-dup" },
      { seq: 2, sessionKey: "session-dup" },
    ]);

    first.resetAgentEventsForTest();
  });

  test("sweeps stale run contexts and clears their sequence state", async () => {
    const stop = vi.spyOn(Date, "now");
    stop.mockReturnValue(100);
    registerAgentRunContext("run-stale", { registeredAt: 100, sessionKey: "session-stale" });
    registerAgentRunContext("run-active", { registeredAt: 100, sessionKey: "session-active" });

    stop.mockReturnValue(200);
    emitAgentEvent({ data: { text: "stale" }, runId: "run-stale", stream: "assistant" });

    stop.mockReturnValue(900);
    emitAgentEvent({ data: { text: "active" }, runId: "run-active", stream: "assistant" });

    stop.mockReturnValue(1000);
    expect(sweepStaleRunContexts(500)).toBe(1);
    expect(getAgentRunContext("run-stale")).toBeUndefined();
    expect(getAgentRunContext("run-active")).toMatchObject({ sessionKey: "session-active" });

    const seen: { runId: string; seq: number }[] = [];
    const unsubscribe = onAgentEvent((evt) => {
      if (evt.runId === "run-stale" || evt.runId === "run-active") {
        seen.push({ runId: evt.runId, seq: evt.seq });
      }
    });

    emitAgentEvent({ data: { text: "restarted" }, runId: "run-stale", stream: "assistant" });
    emitAgentEvent({ data: { text: "continued" }, runId: "run-active", stream: "assistant" });

    unsubscribe();
    stop.mockRestore();

    expect(seen).toEqual([
      { runId: "run-stale", seq: 1 },
      { runId: "run-active", seq: 2 },
    ]);
  });
});
