import { describe, expect, it, vi } from "vitest";
import {
  clearMemorySyncedSessionFiles,
  runMemoryTargetedSessionSync,
} from "./manager-targeted-sync.js";

describe("memory targeted session sync", () => {
  it("preserves unrelated dirty sessions after targeted cleanup", () => {
    const secondSessionPath = "/tmp/targeted-dirty-second.jsonl";
    const sessionsDirtyFiles = new Set(["/tmp/targeted-dirty-first.jsonl", secondSessionPath]);

    const sessionsDirty = clearMemorySyncedSessionFiles({
      sessionsDirtyFiles,
      targetSessionFiles: ["/tmp/targeted-dirty-first.jsonl"],
    });

    expect(sessionsDirtyFiles.has(secondSessionPath)).toBe(true);
    expect(sessionsDirty).toBe(true);
  });

  it("runs a full reindex after fallback activates during targeted sync", async () => {
    const activateFallbackProvider = vi.fn(async () => true);
    const runSafeReindex = vi.fn(async () => {});
    const runUnsafeReindex = vi.fn(async () => {});

    await runMemoryTargetedSessionSync({
      activateFallbackProvider,
      hasSessionSource: true,
      progress: undefined,
      reason: "post-compaction",
      runSafeReindex,
      runUnsafeReindex,
      sessionsDirtyFiles: new Set(),
      shouldFallbackOnError: () => true,
      syncSessionFiles: async () => {
        throw new Error("embedding backend failed");
      },
      targetSessionFiles: new Set(["/tmp/targeted-fallback.jsonl"]),
      useUnsafeReindex: false,
    });

    expect(activateFallbackProvider).toHaveBeenCalledWith("embedding backend failed");
    expect(runSafeReindex).toHaveBeenCalledWith({
      force: true,
      progress: undefined,
      reason: "post-compaction",
    });
    expect(runUnsafeReindex).not.toHaveBeenCalled();
  });

  it("uses the unsafe reindex path when enabled", async () => {
    const runSafeReindex = vi.fn(async () => {});
    const runUnsafeReindex = vi.fn(async () => {});

    await runMemoryTargetedSessionSync({
      activateFallbackProvider: async () => true,
      hasSessionSource: true,
      progress: undefined,
      reason: "post-compaction",
      runSafeReindex,
      runUnsafeReindex,
      sessionsDirtyFiles: new Set(),
      shouldFallbackOnError: () => true,
      syncSessionFiles: async () => {
        throw new Error("embedding backend failed");
      },
      targetSessionFiles: new Set(["/tmp/targeted-fallback.jsonl"]),
      useUnsafeReindex: true,
    });

    expect(runUnsafeReindex).toHaveBeenCalledWith({
      force: true,
      progress: undefined,
      reason: "post-compaction",
    });
    expect(runSafeReindex).not.toHaveBeenCalled();
  });
});
