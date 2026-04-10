import { describe, expect, it } from "vitest";
import {
  assertNoMemoryLeak,
  detectMemoryLeak,
  takeSnapshot,
  withMemoryLeakDetection,
  type MemorySnapshot,
} from "./memory-leak-detect.js";

describe("memory-leak-detect", () => {
  it("takes memory snapshots", () => {
    const snapshot = takeSnapshot();
    expect(snapshot).toHaveProperty("timestamp");
    expect(snapshot).toHaveProperty("heapUsedMB");
    expect(snapshot).toHaveProperty("heapTotalMB");
    expect(snapshot.heapUsedMB).toBeGreaterThan(0);
  });

  it("detects memory leaks", () => {
    const initial: MemorySnapshot = {
      timestamp: 0,
      heapUsedMB: 100,
      heapTotalMB: 200,
      externalMB: 0,
    };
    const final: MemorySnapshot = {
      timestamp: 1000,
      heapUsedMB: 120,
      heapTotalMB: 220,
      externalMB: 0,
    };
    const result = detectMemoryLeak(initial, final, 1000);
    expect(result.growthMB).toBe(20);
    expect(result.leaked).toBe(true);
  });

  it("does not detect leak for small growth", () => {
    const initial: MemorySnapshot = {
      timestamp: 0,
      heapUsedMB: 100,
      heapTotalMB: 200,
      externalMB: 0,
    };
    const final: MemorySnapshot = {
      timestamp: 1000,
      heapUsedMB: 105,
      heapTotalMB: 205,
      externalMB: 0,
    };
    const result = detectMemoryLeak(initial, final, 1000);
    expect(result.growthMB).toBe(5);
    expect(result.leaked).toBe(false);
  });

  it("runs function with memory detection", async () => {
    const { result, leakResult } = await withMemoryLeakDetection(async () => {
      return "test result";
    });
    expect(result).toBe("test result");
    expect(leakResult).toHaveProperty("leaked");
    expect(leakResult).toHaveProperty("growthMB");
  });

  it("throws on memory leak assertion", () => {
    const result = {
      leaked: true,
      growthMB: 15,
      growthRateMBPerSec: 1,
      snapshots: [],
    };
    expect(() => assertNoMemoryLeak(result)).toThrow("Memory leak detected");
  });

  it("does not throw when no leak", () => {
    const result = {
      leaked: false,
      growthMB: 5,
      growthRateMBPerSec: 0.1,
      snapshots: [],
    };
    expect(() => assertNoMemoryLeak(result)).not.toThrow();
  });
});
