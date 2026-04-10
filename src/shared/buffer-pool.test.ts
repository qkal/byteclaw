import { describe, expect, it } from "vitest";
import {
  acquireBuffer,
  clearBufferPools,
  getBufferPoolStats,
  releaseBuffer,
  withBuffer,
} from "./buffer-pool.js";

describe("buffer-pool", () => {
  it("acquires and releases buffers", () => {
    const buffer = acquireBuffer(100);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBe(100);
    releaseBuffer(buffer);
  });

  it("reuses buffers from pool", () => {
    const initialStats = getBufferPoolStats();
    const buffer1 = acquireBuffer(100);
    releaseBuffer(buffer1);
    const buffer2 = acquireBuffer(100);
    releaseBuffer(buffer2);
    const finalStats = getBufferPoolStats();
    expect(finalStats.small.size).toBeGreaterThanOrEqual(initialStats.small.size);
  });

  it("handles different buffer sizes", () => {
    const small = acquireBuffer(512);
    const medium = acquireBuffer(8192);
    const large = acquireBuffer(128 * 1024);

    expect(small.length).toBe(512);
    expect(medium.length).toBe(8192);
    expect(large.length).toBe(128 * 1024);

    releaseBuffer(small);
    releaseBuffer(medium);
    releaseBuffer(large);
  });

  it("provides pool statistics", () => {
    const stats = getBufferPoolStats();
    expect(stats.small).toHaveProperty("size");
    expect(stats.small).toHaveProperty("maxSize");
    expect(stats.small).toHaveProperty("totalBytes");
  });

  it("clears all pools", () => {
    clearBufferPools();
    const stats = getBufferPoolStats();
    expect(stats.small.size).toBe(0);
    expect(stats.medium.size).toBe(0);
    expect(stats.large.size).toBe(0);
  });

  it("manages buffer lifecycle with withBuffer", async () => {
    let capturedBuffer: Buffer | null = null;
    await withBuffer(100, (buffer) => {
      capturedBuffer = buffer;
      return buffer.toString();
    });
    expect(capturedBuffer).toBeInstanceOf(Buffer);
    expect(capturedBuffer?.length).toBe(100);
  });

  it("releases buffer even if callback throws", async () => {
    const initialStats = getBufferPoolStats();
    await expect(
      withBuffer(100, () => {
        throw new Error("Test error");
      }),
    ).rejects.toThrow("Test error");
    // Buffer should still be released
    const finalStats = getBufferPoolStats();
    expect(finalStats.small.size).toBe(initialStats.small.size);
  });
});
