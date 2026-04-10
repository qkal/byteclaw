/**
 * Memory leak detection utilities for tests.
 * Can be used in test suites to detect memory leaks during test execution.
 */

import v8 from "node:v8";
import { performance } from "node:perf_hooks";

const MB = 1024 * 1024;

export interface MemorySnapshot {
  timestamp: number;
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
}

export interface MemoryLeakResult {
  leaked: boolean;
  growthMB: number;
  growthRateMBPerSec: number;
  snapshots: MemorySnapshot[];
}

/**
 * Take a memory snapshot.
 */
export function takeSnapshot(): MemorySnapshot {
  const stats = v8.getHeapStatistics();
  return {
    timestamp: performance.now(),
    heapUsedMB: stats.used_heap_size / MB,
    heapTotalMB: stats.total_heap_size / MB,
    externalMB: stats.external_memory / MB,
  };
}

/**
 * Detect memory leaks between two snapshots.
 */
export function detectMemoryLeak(
  initial: MemorySnapshot,
  final: MemorySnapshot,
  durationMs: number,
): MemoryLeakResult {
  const growthMB = final.heapUsedMB - initial.heapUsedMB;
  const growthRateMBPerSec = (growthMB / durationMs) * 1000;
  
  // Consider it a leak if growth exceeds 10MB or growth rate > 0.5 MB/s
  const leaked = growthMB > 10 || growthRateMBPerSec > 0.5;

  return {
    leaked,
    growthMB,
    growthRateMBPerSec,
    snapshots: [initial, final],
  };
}

/**
 * Force garbage collection if available.
 */
export function forceGC(): void {
  if (global.gc) {
    global.gc();
  }
}

/**
 * Run a function and detect memory leaks.
 */
export async function withMemoryLeakDetection<T>(
  fn: () => Promise<T> | T,
  options: { forceGC?: boolean; thresholdMB?: number } = {},
): Promise<{ result: T; leakResult: MemoryLeakResult }> {
  const { forceGC: shouldForceGC = true, thresholdMB = 10 } = options;

  if (shouldForceGC) {
    forceGC();
  }

  const initial = takeSnapshot();
  const startTime = performance.now();

  const result = await fn();

  if (shouldForceGC) {
    forceGC();
  }

  const final = takeSnapshot();
  const duration = performance.now() - startTime;

  const leakResult = detectMemoryLeak(initial, final, duration);
  
  // Override leak detection with custom threshold
  if (leakResult.growthMB > thresholdMB) {
    leakResult.leaked = true;
  }

  return { result, leakResult };
}

/**
 * Assert that no memory leak occurred.
 */
export function assertNoMemoryLeak(
  result: MemoryLeakResult,
  message?: string,
): void {
  if (result.leaked) {
    throw new Error(
      message ||
        `Memory leak detected: ${result.growthMB.toFixed(2)}MB growth, ${result.growthRateMBPerSec.toFixed(4)}MB/s`,
    );
  }
}
