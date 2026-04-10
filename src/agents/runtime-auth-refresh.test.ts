import { describe, expect, it } from "vitest";
import { clampRuntimeAuthRefreshDelayMs } from "./runtime-auth-refresh.js";

describe("clampRuntimeAuthRefreshDelayMs", () => {
  it("clamps far-future refresh delays to a timer-safe ceiling", () => {
    expect(
      clampRuntimeAuthRefreshDelayMs({
        minDelayMs: 60_000,
        now: 0,
        refreshAt: 12_345_678_901_000,
      }),
    ).toBe(2_147_483_647);
  });

  it("still respects the configured minimum delay", () => {
    expect(
      clampRuntimeAuthRefreshDelayMs({
        minDelayMs: 60_000,
        now: 900,
        refreshAt: 1000,
      }),
    ).toBe(60_000);
  });
});
