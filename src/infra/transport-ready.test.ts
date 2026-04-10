import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const transportReadyMocks = vi.hoisted(() => ({
  injectedSleepError: null as Error | null,
}));

type TransportReadyModule = typeof import("./transport-ready.js");
let waitForTransportReady: TransportReadyModule["waitForTransportReady"];

vi.mock("./backoff.js", () => ({
  sleepWithAbort: async (ms: number, signal?: AbortSignal) => {
    if (transportReadyMocks.injectedSleepError) {
      throw transportReadyMocks.injectedSleepError;
    }
    if (signal?.aborted) {
      throw new Error("aborted");
    }
    if (ms <= 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
}));

function createRuntime() {
  return { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
}

describe("waitForTransportReady", () => {
  beforeAll(async () => {
    ({ waitForTransportReady } = await import("./transport-ready.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    transportReadyMocks.injectedSleepError = null;
  });

  it("returns when the check succeeds and logs after the delay", async () => {
    const runtime = createRuntime();
    let attempts = 0;
    const readyPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 220,
      // Deterministic: first attempt at t=0 won't log; second attempt at t=50 will.
      logAfterMs: 1,
      logIntervalMs: 1000,
      pollIntervalMs: 50,
      runtime,
      check: async () => {
        attempts += 1;
        if (attempts > 2) {
          return { ok: true };
        }
        return { error: "not ready", ok: false };
      },
    });

    await vi.advanceTimersByTimeAsync(200);

    await readyPromise;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("throws after the timeout", async () => {
    const runtime = createRuntime();
    const waitPromise = waitForTransportReady({
      check: async () => ({ error: "still down", ok: false }),
      label: "test transport",
      logAfterMs: 0,
      logIntervalMs: 1000,
      pollIntervalMs: 50,
      runtime,
      timeoutMs: 110,
    });
    const asserted = expect(waitPromise).rejects.toThrow("test transport not ready");
    await vi.advanceTimersByTimeAsync(200);
    await asserted;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("returns early when aborted", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    controller.abort();
    await waitForTransportReady({
      abortSignal: controller.signal,
      check: async () => ({ error: "still down", ok: false }),
      label: "test transport",
      runtime,
      timeoutMs: 200,
    });
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("stops polling when aborted during the sleep interval", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    let attempts = 0;

    const waitPromise = waitForTransportReady({
      abortSignal: controller.signal,
      check: async () => {
        attempts += 1;
        setTimeout(() => controller.abort(), 10);
        return { error: "still down", ok: false };
      },
      label: "test transport",
      pollIntervalMs: 50,
      runtime,
      timeoutMs: 500,
    });

    await vi.advanceTimersByTimeAsync(100);
    await waitPromise;

    expect(attempts).toBe(1);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("logs repeated unknown-error retries and the final timeout message", async () => {
    const runtime = createRuntime();
    const waitPromise = waitForTransportReady({
      check: async () => ({ error: null, ok: false }),
      label: "test transport",
      logAfterMs: 0,
      logIntervalMs: 50,
      pollIntervalMs: 50,
      runtime,
      timeoutMs: 120,
    });

    const asserted = expect(waitPromise).rejects.toThrow(
      "test transport not ready (unknown error)",
    );
    await vi.advanceTimersByTimeAsync(200);
    await asserted;

    expect(runtime.error).toHaveBeenCalledTimes(2);
    expect(runtime.error.mock.calls.at(0)?.[0]).toContain("unknown error");
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("not ready after 120ms");
  });

  it("rethrows non-abort sleep failures", async () => {
    const runtime = createRuntime();
    transportReadyMocks.injectedSleepError = new Error("sleep exploded");

    await expect(
      waitForTransportReady({
        check: async () => ({ error: "still down", ok: false }),
        label: "test transport",
        pollIntervalMs: 50,
        runtime,
        timeoutMs: 500,
      }),
    ).rejects.toThrow("sleep exploded");

    expect(runtime.error).not.toHaveBeenCalled();
  });
});
