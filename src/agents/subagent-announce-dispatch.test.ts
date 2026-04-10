import { describe, expect, it, vi } from "vitest";
import {
  mapQueueOutcomeToDeliveryResult,
  runSubagentAnnounceDispatch,
} from "./subagent-announce-dispatch.js";

describe("mapQueueOutcomeToDeliveryResult", () => {
  it("maps steered to delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("steered")).toEqual({
      delivered: true,
      path: "steered",
    });
  });

  it("maps queued to delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("queued")).toEqual({
      delivered: true,
      path: "queued",
    });
  });

  it("maps none to not-delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("none")).toEqual({
      delivered: false,
      path: "none",
    });
  });
});

describe("runSubagentAnnounceDispatch", () => {
  async function runNonCompletionDispatch(params: {
    queueOutcome: "none" | "queued" | "steered";
    directDelivered?: boolean;
  }) {
    const queue = vi.fn(async () => params.queueOutcome);
    const direct = vi.fn(async () => ({
      delivered: params.directDelivered ?? true,
      path: "direct" as const,
    }));
    const result = await runSubagentAnnounceDispatch({
      direct,
      expectsCompletionMessage: false,
      queue,
    });
    return { direct, queue, result };
  }

  it("uses queue-first ordering for non-completion mode", async () => {
    const { queue, direct, result } = await runNonCompletionDispatch({ queueOutcome: "none" });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(true);
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { delivered: false, error: undefined, path: "none", phase: "queue-primary" },
      { delivered: true, error: undefined, path: "direct", phase: "direct-primary" },
    ]);
  });

  it("short-circuits direct send when non-completion queue delivers", async () => {
    const { queue, direct, result } = await runNonCompletionDispatch({ queueOutcome: "queued" });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result.path).toBe("queued");
    expect(result.phases).toEqual([
      { delivered: true, error: undefined, path: "queued", phase: "queue-primary" },
    ]);
  });

  it("uses direct-first ordering for completion mode", async () => {
    const queue = vi.fn(async () => "queued" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      direct,
      expectsCompletionMessage: true,
      queue,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { delivered: true, error: undefined, path: "direct", phase: "direct-primary" },
    ]);
  });

  it("falls back to queue when completion direct send fails", async () => {
    const queue = vi.fn(async () => "steered" as const);
    const direct = vi.fn(async () => ({
      delivered: false,
      error: "network",
      path: "direct" as const,
    }));

    const result = await runSubagentAnnounceDispatch({
      direct,
      expectsCompletionMessage: true,
      queue,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(result.path).toBe("steered");
    expect(result.phases).toEqual([
      { delivered: false, error: "network", path: "direct", phase: "direct-primary" },
      { delivered: true, error: undefined, path: "steered", phase: "queue-fallback" },
    ]);
  });

  it("returns direct failure when completion fallback queue cannot deliver", async () => {
    const queue = vi.fn(async () => "none" as const);
    const direct = vi.fn(async () => ({
      delivered: false,
      error: "failed",
      path: "direct" as const,
    }));

    const result = await runSubagentAnnounceDispatch({
      direct,
      expectsCompletionMessage: true,
      queue,
    });

    expect(result).toMatchObject({
      delivered: false,
      error: "failed",
      path: "direct",
    });
    expect(result.phases).toEqual([
      { delivered: false, error: "failed", path: "direct", phase: "direct-primary" },
      { delivered: false, error: undefined, path: "none", phase: "queue-fallback" },
    ]);
  });

  it("does not fall through to direct delivery when non-completion queue drops the new item", async () => {
    const queue = vi.fn(async () => "dropped" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      direct,
      expectsCompletionMessage: false,
      queue,
    });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      phases: [{ delivered: false, error: undefined, path: "none", phase: "queue-primary" }],
    });
  });

  it("preserves direct failure when completion dispatch aborts before fallback queue", async () => {
    const controller = new AbortController();
    const queue = vi.fn(async () => "queued" as const);
    const direct = vi.fn(async () => {
      controller.abort();
      return {
        delivered: false,
        error: "direct failed before abort",
        path: "direct" as const,
      };
    });

    const result = await runSubagentAnnounceDispatch({
      direct,
      expectsCompletionMessage: true,
      queue,
      signal: controller.signal,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      delivered: false,
      error: "direct failed before abort",
      path: "direct",
    });
    expect(result.phases).toEqual([
      {
        delivered: false,
        error: "direct failed before abort",
        path: "direct",
        phase: "direct-primary",
      },
    ]);
  });

  it("returns none immediately when signal is already aborted", async () => {
    const queue = vi.fn(async () => "none" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagentAnnounceDispatch({
      direct,
      expectsCompletionMessage: true,
      queue,
      signal: controller.signal,
    });

    expect(queue).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      phases: [],
    });
  });
});
