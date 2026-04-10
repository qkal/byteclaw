import { describe, expect, it, vi } from "vitest";
import { type BackoffPolicy, computeBackoff, sleepWithAbort } from "./backoff.js";

describe("backoff helpers", () => {
  const policy: BackoffPolicy = {
    factor: 2,
    initialMs: 100,
    jitter: 0.5,
    maxMs: 250,
  };

  it("treats attempts below one as the first backoff step", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(computeBackoff(policy, 0)).toBe(100);
      expect(computeBackoff(policy, 1)).toBe(100);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("adds jitter and clamps to maxMs", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      expect(computeBackoff(policy, 2)).toBe(250);
      expect(computeBackoff({ ...policy, maxMs: 450 }, 2)).toBe(300);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("returns immediately for non-positive sleep durations", async () => {
    await expect(sleepWithAbort(0, AbortSignal.abort())).resolves.toBeUndefined();
    await expect(sleepWithAbort(-5)).resolves.toBeUndefined();
  });

  it("wraps aborted sleeps with a stable aborted error", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleepWithAbort(5, controller.signal)).rejects.toMatchObject({
      cause: expect.anything(),
      message: "aborted",
    });
  });
});
