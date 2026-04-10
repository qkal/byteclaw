import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  isDiagnosticsEnabled,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "./diagnostic-events.js";

describe("diagnostic-events", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  it("emits monotonic seq and timestamps to subscribers", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(111).mockReturnValueOnce(222);
    const events: { seq: number; ts: number; type: string }[] = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ seq: event.seq, ts: event.ts, type: event.type });
    });

    emitDiagnosticEvent({
      type: "model.usage",
      usage: { total: 1 },
    });
    emitDiagnosticEvent({
      state: "processing",
      type: "session.state",
    });
    stop();

    expect(events).toEqual([
      { seq: 1, ts: 111, type: "model.usage" },
      { seq: 2, ts: 222, type: "session.state" },
    ]);
  });

  it("isolates listener failures and logs them", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    onDiagnosticEvent(() => {
      throw new Error("boom");
    });
    onDiagnosticEvent((event) => {
      seen.push(event.type);
    });

    emitDiagnosticEvent({
      source: "telegram",
      type: "message.queued",
    });

    expect(seen).toEqual(["message.queued"]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("listener error type=message.queued seq=1: Error: boom"),
    );
  });

  it("supports unsubscribe and full reset", () => {
    const seen: string[] = [];
    const stop = onDiagnosticEvent((event) => {
      seen.push(event.type);
    });

    emitDiagnosticEvent({
      channel: "telegram",
      type: "webhook.received",
    });
    stop();
    emitDiagnosticEvent({
      channel: "telegram",
      type: "webhook.processed",
    });

    expect(seen).toEqual(["webhook.received"]);

    resetDiagnosticEventsForTest();
    emitDiagnosticEvent({
      channel: "telegram",
      error: "failed",
      type: "webhook.error",
    });
    expect(seen).toEqual(["webhook.received"]);
  });

  it("drops recursive emissions after the guard threshold", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    onDiagnosticEvent(() => {
      calls += 1;
      emitDiagnosticEvent({
        lane: "main",
        queueSize: calls,
        type: "queue.lane.enqueue",
      });
    });

    emitDiagnosticEvent({
      lane: "main",
      queueSize: 0,
      type: "queue.lane.enqueue",
    });

    expect(calls).toBe(101);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "recursion guard tripped at depth=101, dropping type=queue.lane.enqueue",
      ),
    );
  });

  it("requires an explicit true diagnostics flag", () => {
    expect(isDiagnosticsEnabled()).toBe(false);
    expect(isDiagnosticsEnabled({ diagnostics: { enabled: false } } as never)).toBe(false);
    expect(isDiagnosticsEnabled({ diagnostics: { enabled: true } } as never)).toBe(true);
  });
});
