import { describe, expect, it } from "vitest";
import {
  MEMORY_BATCH_FAILURE_LIMIT,
  recordMemoryBatchFailure,
  resetMemoryBatchFailureState,
} from "./manager-batch-state.js";

describe("memory batch state", () => {
  it("resets failures after recovery", () => {
    expect(
      resetMemoryBatchFailureState({
        count: 1,
        enabled: true,
        lastError: "batch failed",
        lastProvider: "openai",
      }),
    ).toEqual({
      count: 0,
      enabled: true,
      lastError: undefined,
      lastProvider: undefined,
    });
  });

  it("disables batching after repeated failures", () => {
    const once = recordMemoryBatchFailure(
      { count: 0, enabled: true },
      { attempts: 1, message: "batch failed", provider: "openai" },
    );
    expect(once).toEqual({
      count: 1,
      enabled: true,
      lastError: "batch failed",
      lastProvider: "openai",
    });

    const twice = recordMemoryBatchFailure(once, {
      attempts: 1,
      message: "batch failed again",
      provider: "openai",
    });
    expect(twice).toEqual({
      count: MEMORY_BATCH_FAILURE_LIMIT,
      enabled: false,
      lastError: "batch failed again",
      lastProvider: "openai",
    });
  });

  it("force-disables batching immediately", () => {
    expect(
      recordMemoryBatchFailure(
        { count: 0, enabled: true },
        { forceDisable: true, message: "not available", provider: "gemini" },
      ),
    ).toEqual({
      count: MEMORY_BATCH_FAILURE_LIMIT,
      enabled: false,
      lastError: "not available",
      lastProvider: "gemini",
    });
  });

  it("leaves disabled state unchanged", () => {
    expect(
      recordMemoryBatchFailure(
        { count: MEMORY_BATCH_FAILURE_LIMIT, enabled: false, lastError: "x", lastProvider: "y" },
        { message: "ignored", provider: "openai" },
      ),
    ).toEqual({
      count: MEMORY_BATCH_FAILURE_LIMIT,
      enabled: false,
      lastError: "x",
      lastProvider: "y",
    });
  });
});
