/**
 * Runtime comparison utilities for testing Bun vs Node behavior.
 * Provides tools to measure and compare performance and behavior differences.
 */

import { getEffectiveRuntime, getRuntimeVersion } from "./runtime-detection.js";

export interface ComparisonResult<T> {
  bun: T;
  node: T;
  difference: number;
  percentDifference: number;
}

export interface PerformanceResult {
  runtime: "bun" | "node";
  durationMs: number;
  memoryBytes?: number;
}

/**
 * Measures execution time of a function.
 */
export async function measurePerformance<T>(
  fn: () => Promise<T> | T,
): Promise<PerformanceResult & { result: T }> {
  const startMemory = process.memoryUsage().heapUsed;
  const startTime = performance.now();
  const result = await fn();
  const endTime = performance.now();
  const endMemory = process.memoryUsage().heapUsed;

  return {
    runtime: getEffectiveRuntime(),
    durationMs: endTime - startTime,
    memoryBytes: endMemory - startMemory,
    result,
  };
}

/**
 * Compares performance between runtimes.
 * Note: This must be run separately under each runtime and results combined.
 */
export function comparePerformanceResults(
  bunResult: PerformanceResult,
  nodeResult: PerformanceResult,
): ComparisonResult<number> {
  const difference = bunResult.durationMs - nodeResult.durationMs;
  const percentDifference = (difference / nodeResult.durationMs) * 100;

  return {
    bun: bunResult.durationMs,
    node: nodeResult.durationMs,
    difference,
    percentDifference,
  };
}

/**
 * Logs a comparison result in a readable format.
 */
export function logComparisonResult<T>(label: string, result: ComparisonResult<T>): void {
  console.log(`\n${label}:`);
  console.log(`  Bun: ${result.bun}`);
  console.log(`  Node: ${result.node}`);
  console.log(
    `  Difference: ${result.difference.toFixed(2)} (${result.percentDifference.toFixed(1)}%)`,
  );
}

/**
 * Checks if a value is within acceptable tolerance.
 */
export function isWithinTolerance(
  actual: number,
  expected: number,
  tolerancePercent: number = 10,
): boolean {
  const difference = Math.abs(actual - expected);
  const tolerance = (expected * tolerancePercent) / 100;
  return difference <= tolerance;
}

/**
 * Asserts that Bun is within performance tolerance of Node.
 */
export function assertPerformanceTolerance(
  bunMs: number,
  nodeMs: number,
  tolerancePercent: number = 20,
): void {
  const ratio = bunMs / nodeMs;
  const maxRatio = 1 + tolerancePercent / 100;

  if (ratio > maxRatio) {
    throw new Error(
      `Bun performance outside tolerance: ${bunMs}ms vs ${nodeMs}ms (${ratio.toFixed(2)}x, max ${maxRatio.toFixed(2)}x)`,
    );
  }
}

/**
 * Runtime-aware assertion that logs runtime information on failure.
 */
export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  const runtime = getEffectiveRuntime();
  if (actual !== expected) {
    const errorMsg = message
      ? `[${runtime} ${getRuntimeVersion()}] ${message}`
      : `[${runtime} ${getRuntimeVersion()}] Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    throw new Error(errorMsg);
  }
}
