import { describe, expect, it } from "vitest";
import {
  applyQueueRuntimeSettings,
  buildQueueSummaryPrompt,
  clearQueueSummaryState,
  drainCollectItemIfNeeded,
  previewQueueSummaryPrompt,
} from "./queue-helpers.js";

describe("applyQueueRuntimeSettings", () => {
  it("updates runtime queue settings with normalization", () => {
    const target = {
      cap: 20,
      debounceMs: 1000,
      dropPolicy: "summarize" as const,
      mode: "followup" as const,
    };

    applyQueueRuntimeSettings({
      settings: {
        cap: 9.8,
        debounceMs: -12,
        dropPolicy: "new",
        mode: "collect",
      },
      target,
    });

    expect(target).toEqual({
      cap: 9,
      debounceMs: 0,
      dropPolicy: "new",
      mode: "collect",
    });
  });

  it("keeps existing values when optional settings are missing/invalid", () => {
    const target = {
      cap: 20,
      debounceMs: 1000,
      dropPolicy: "summarize" as const,
      mode: "followup" as const,
    };

    applyQueueRuntimeSettings({
      settings: {
        cap: 0,
        mode: "queue",
      },
      target,
    });

    expect(target).toEqual({
      cap: 20,
      debounceMs: 1000,
      dropPolicy: "summarize",
      mode: "queue",
    });
  });
});

describe("queue summary helpers", () => {
  it("previewQueueSummaryPrompt does not mutate state", () => {
    const state = {
      dropPolicy: "summarize" as const,
      droppedCount: 2,
      summaryLines: ["first", "second"],
    };

    const prompt = previewQueueSummaryPrompt({
      noun: "message",
      state,
    });

    expect(prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
    expect(prompt).toContain("first");
    expect(state).toEqual({
      dropPolicy: "summarize",
      droppedCount: 2,
      summaryLines: ["first", "second"],
    });
  });

  it("buildQueueSummaryPrompt clears state after rendering", () => {
    const state = {
      dropPolicy: "summarize" as const,
      droppedCount: 1,
      summaryLines: ["line"],
    };

    const prompt = buildQueueSummaryPrompt({
      noun: "announce",
      state,
    });

    expect(prompt).toContain("[Queue overflow] Dropped 1 announce due to cap.");
    expect(state).toEqual({
      dropPolicy: "summarize",
      droppedCount: 0,
      summaryLines: [],
    });
  });

  it("clearQueueSummaryState resets summary counters", () => {
    const state = {
      dropPolicy: "summarize" as const,
      droppedCount: 5,
      summaryLines: ["a", "b"],
    };
    clearQueueSummaryState(state);
    expect(state.droppedCount).toBe(0);
    expect(state.summaryLines).toEqual([]);
  });
});

describe("drainCollectItemIfNeeded", () => {
  it("skips when neither force mode nor cross-channel routing is active", async () => {
    const seen: number[] = [];
    const items = [1];

    const result = await drainCollectItemIfNeeded({
      forceIndividualCollect: false,
      isCrossChannel: false,
      items,
      run: async (item) => {
        seen.push(item);
      },
    });

    expect(result).toBe("skipped");
    expect(seen).toEqual([]);
    expect(items).toEqual([1]);
  });

  it("drains one item in force mode", async () => {
    const seen: number[] = [];
    const items = [1, 2];

    const result = await drainCollectItemIfNeeded({
      forceIndividualCollect: true,
      isCrossChannel: false,
      items,
      run: async (item) => {
        seen.push(item);
      },
    });

    expect(result).toBe("drained");
    expect(seen).toEqual([1]);
    expect(items).toEqual([2]);
  });

  it("switches to force mode and returns empty when cross-channel with no queued item", async () => {
    let forced = false;

    const result = await drainCollectItemIfNeeded({
      forceIndividualCollect: false,
      isCrossChannel: true,
      items: [],
      run: async () => {},
      setForceIndividualCollect: (next) => {
        forced = next;
      },
    });

    expect(result).toBe("empty");
    expect(forced).toBe(true);
  });
});
