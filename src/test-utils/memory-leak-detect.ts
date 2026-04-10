/**
 * Production-grade memory leak detection utilities for tests and CI.
 * Can be used in test suites to detect memory leaks during test execution.
 */

import v8 from "node:v8";
import { performance } from "node:perf_hooks";

const MB = 1024 * 1024;

export interface MemorySnapshot {
  timestamp: number;
  heapUsedMB: number;
  heapTotalMB: number;
  heapLimitMB: number;
  externalMB: number;
  arrayBuffersMB: number;
}

export interface MemoryLeakResult {
  leaked: boolean;
  growthMB: number;
  growthRateMBPerSec: number;
  snapshots: MemorySnapshot[];
  details: {
    initialHeapMB: number;
    finalHeapMB: number;
    peakHeapMB: number;
    gcCollections?: number;
  };
}

export interface MemoryLeakDetectorOptions {
  thresholdMB?: number;
  growthRateThresholdMBPerSec?: number;
  enableGC?: boolean;
  sampleIntervalMs?: number;
  maxSamples?: number;
}

/**
 * Take a memory snapshot with detailed metrics.
 */
export function takeSnapshot(): MemorySnapshot {
  const stats = v8.getHeapStatistics();
  const heapCodeAndStatistics = v8.getHeapCodeStatistics();

  return {
    timestamp: performance.now(),
    heapUsedMB: stats.used_heap_size / MB,
    heapTotalMB: stats.total_heap_size / MB,
    heapLimitMB: stats.heap_size_limit / MB,
    externalMB: stats.external_memory / MB,
    arrayBuffersMB: (heapCodeAndStatistics.code_and_metadata_size ?? 0) / MB,
  };
}

/**
 * Detect memory leaks between two snapshots with configurable thresholds.
 */
export function detectMemoryLeak(
  initial: MemorySnapshot,
  final: MemorySnapshot,
  durationMs: number,
  options: MemoryLeakDetectorOptions = {},
): MemoryLeakResult {
  const thresholdMB = options.thresholdMB ?? 10;
  const growthRateThresholdMBPerSec = options.growthRateThresholdMBPerSec ?? 0.5;

  const growthMB = final.heapUsedMB - initial.heapUsedMB;
  const growthRateMBPerSec = (growthMB / durationMs) * 1000;

  // Consider it a leak if growth exceeds threshold or growth rate exceeds threshold
  const leaked = growthMB > thresholdMB || growthRateMBPerSec > growthRateThresholdMBPerSec;

  return {
    leaked,
    growthMB,
    growthRateMBPerSec,
    snapshots: [initial, final],
    details: {
      initialHeapMB: initial.heapUsedMB,
      finalHeapMB: final.heapUsedMB,
      peakHeapMB: Math.max(initial.heapUsedMB, final.heapUsedMB),
    },
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
 * Check if GC is available.
 */
export function isGCAvailable(): boolean {
  return typeof global.gc === "function";
}

/**
 * Run a function and detect memory leaks with configurable options.
 */
export async function withMemoryLeakDetection<T>(
  fn: () => Promise<T> | T,
  options: MemoryLeakDetectorOptions = {},
): Promise<{ result: T; leakResult: MemoryLeakResult }> {
  const { enableGC = true, thresholdMB = 10, growthRateThresholdMBPerSec = 0.5 } = options;

  if (enableGC && isGCAvailable()) {
    forceGC();
  }

  const initial = takeSnapshot();
  const startTime = performance.now();

  const result = await fn();

  if (enableGC && isGCAvailable()) {
    forceGC();
  }

  const final = takeSnapshot();
  const duration = performance.now() - startTime;

  const leakResult = detectMemoryLeak(initial, final, duration, {
    thresholdMB,
    growthRateThresholdMBPerSec,
  });

  return { result, leakResult };
}

/**
 * Assert that no memory leak occurred with detailed error message.
 */
export function assertNoMemoryLeak(result: MemoryLeakResult, message?: string): void {
  if (result.leaked) {
    const details = [
      `Memory leak detected`,
      `Growth: ${result.growthMB.toFixed(2)}MB`,
      `Growth rate: ${result.growthRateMBPerSec.toFixed(4)}MB/s`,
      `Initial heap: ${result.details.initialHeapMB.toFixed(2)}MB`,
      `Final heap: ${result.details.finalHeapMB.toFixed(2)}MB`,
      `Peak heap: ${result.details.peakHeapMB.toFixed(2)}MB`,
    ].join("\n  ");
    throw new Error(message ? `${message}\n${details}` : details);
  }
}

/**
 * Continuous memory monitoring during execution.
 */
export class MemoryMonitor {
  private snapshots: MemorySnapshot[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private options: MemoryLeakDetectorOptions;

  constructor(options: MemoryLeakDetectorOptions = {}) {
    this.options = {
      sampleIntervalMs: options.sampleIntervalMs ?? 1000,
      maxSamples: options.maxSamples ?? 1000,
      ...options,
    };
  }

  /**
   * Start monitoring memory usage.
   */
  start(): void {
    if (this.interval !== null) {
      return;
    }

    this.interval = setInterval(() => {
      this.snapshots.push(takeSnapshot());

      // Trim snapshots if exceeds max
      if (this.snapshots.length > this.options.maxSamples!) {
        this.snapshots.shift();
      }
    }, this.options.sampleIntervalMs);
  }

  /**
   * Stop monitoring and analyze results.
   */
  stop(): MemoryLeakResult {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (this.snapshots.length < 2) {
      return {
        leaked: false,
        growthMB: 0,
        growthRateMBPerSec: 0,
        snapshots: this.snapshots,
        details: {
          initialHeapMB: 0,
          finalHeapMB: 0,
          peakHeapMB: 0,
        },
      };
    }

    const initial = this.snapshots[0];
    const final = this.snapshots[this.snapshots.length - 1];
    const duration = final.timestamp - initial.timestamp;

    return detectMemoryLeak(initial, final, duration, this.options);
  }

  /**
   * Get current snapshots.
   */
  getSnapshots(): MemorySnapshot[] {
    return [...this.snapshots];
  }

  /**
   * Clear snapshots.
   */
  clear(): void {
    this.snapshots = [];
  }
}
