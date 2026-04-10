import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoopRateLimiter } from "./loop-rate-limiter.js";

describe("createLoopRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows messages below the threshold", () => {
    const limiter = createLoopRateLimiter({ maxHits: 3, windowMs: 10_000 });
    limiter.record("conv:1");
    limiter.record("conv:1");
    expect(limiter.isRateLimited("conv:1")).toBe(false);
  });

  it("rate limits at the threshold", () => {
    const limiter = createLoopRateLimiter({ maxHits: 3, windowMs: 10_000 });
    limiter.record("conv:1");
    limiter.record("conv:1");
    limiter.record("conv:1");
    expect(limiter.isRateLimited("conv:1")).toBe(true);
  });

  it("does not cross-contaminate conversations", () => {
    const limiter = createLoopRateLimiter({ maxHits: 2, windowMs: 10_000 });
    limiter.record("conv:1");
    limiter.record("conv:1");
    expect(limiter.isRateLimited("conv:1")).toBe(true);
    expect(limiter.isRateLimited("conv:2")).toBe(false);
  });

  it("resets after the time window expires", () => {
    const limiter = createLoopRateLimiter({ maxHits: 2, windowMs: 5000 });
    limiter.record("conv:1");
    limiter.record("conv:1");
    expect(limiter.isRateLimited("conv:1")).toBe(true);

    vi.advanceTimersByTime(6000);
    expect(limiter.isRateLimited("conv:1")).toBe(false);
  });

  it("returns false for unknown conversations", () => {
    const limiter = createLoopRateLimiter();
    expect(limiter.isRateLimited("unknown")).toBe(false);
  });
});
