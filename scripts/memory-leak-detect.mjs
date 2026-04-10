#!/usr/bin/env node

/**
 * Memory leak detection script for CI.
 * Monitors heap usage and detects potential memory leaks during test runs.
 */

import v8 from "node:v8";
import { performance } from "node:perf_hooks";

const MB = 1024 * 1024;
const WARN_THRESHOLD_MB = 500;
const CRITICAL_THRESHOLD_MB = 1000;
const SAMPLE_INTERVAL_MS = 1000;

class MemoryLeakDetector {
  #samples = [];
  #startTime = performance.now();
  #initialHeap = v8.getHeapStatistics();

  constructor() {
    this.#startSampling();
  }

  #startSampling() {
    this.#interval = setInterval(() => {
      const stats = v8.getHeapStatistics();
      const sample = {
        timestamp: Date.now(),
        elapsedMs: performance.now() - this.#startTime,
        heapUsedMB: stats.used_heap_size / MB,
        heapTotalMB: stats.total_heap_size / MB,
        heapLimitMB: stats.heap_size_limit / MB,
      };
      this.#samples.push(sample);
      this.#checkThresholds(sample);
    }, SAMPLE_INTERVAL_MS);
  }

  #checkThresholds(sample) {
    if (sample.heapUsedMB > CRITICAL_THRESHOLD_MB) {
      console.error(
        `[CRITICAL] Memory usage exceeded ${CRITICAL_THRESHOLD_MB}MB: ${sample.heapUsedMB.toFixed(2)}MB`,
      );
      this.report();
      process.exit(1);
    } else if (sample.heapUsedMB > WARN_THRESHOLD_MB) {
      console.warn(
        `[WARNING] Memory usage exceeded ${WARN_THRESHOLD_MB}MB: ${sample.heapUsedMB.toFixed(2)}MB`,
      );
    }
  }

  stop() {
    clearInterval(this.#interval);
  }

  report() {
    const finalHeap = v8.getHeapStatistics();
    const growthMB = (finalHeap.used_heap_size - this.#initialHeap.used_heap_size) / MB;

    console.log("\n=== Memory Leak Detection Report ===");
    console.log(`Initial heap: ${(this.#initialHeap.used_heap_size / MB).toFixed(2)}MB`);
    console.log(`Final heap: ${(finalHeap.used_heap_size / MB).toFixed(2)}MB`);
    console.log(`Growth: ${growthMB.toFixed(2)}MB`);
    console.log(`Samples collected: ${this.#samples.length}`);
    console.log(`Duration: ${(performance.now() - this.#startTime).toFixed(0)}ms`);

    if (this.#samples.length > 1) {
      const firstSample = this.#samples[0];
      const lastSample = this.#samples[this.#samples.length - 1];
      const growthRate =
        (lastSample.heapUsedMB - firstSample.heapUsedMB) /
        ((lastSample.elapsedMs - firstSample.elapsedMs) / 1000);
      console.log(`Growth rate: ${growthRate.toFixed(4)}MB/s`);

      if (growthRate > 1) {
        console.error("[LEAK SUSPECTED] High memory growth rate detected!");
        process.exit(1);
      } else if (growthRate > 0.1) {
        console.warn("[WARNING] Moderate memory growth detected");
      }
    }

    console.log("===================================\n");
  }
}

// Export for use in test files
export { MemoryLeakDetector };

// If run directly, start monitoring
if (import.meta.url === `file://${process.argv[1]}`) {
  const detector = new MemoryLeakDetector();
  process.on("exit", () => {
    detector.stop();
    detector.report();
  });
  console.log("Memory leak detection started. Press Ctrl+C to stop and see report.");
}
