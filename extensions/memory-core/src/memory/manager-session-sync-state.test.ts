import { describe, expect, it } from "vitest";
import { resolveMemorySessionSyncPlan } from "./manager-session-sync-state.js";

describe("memory session sync state", () => {
  it("tracks active paths and bulk hashes for full scans", () => {
    const plan = resolveMemorySessionSyncPlan({
      existingRows: [
        { hash: "hash-a", path: "sessions/a.jsonl" },
        { hash: "hash-b", path: "sessions/b.jsonl" },
      ],
      files: ["/tmp/a.jsonl", "/tmp/b.jsonl"],
      needsFullReindex: false,
      sessionPathForFile: (file) => `sessions/${file.split("/").at(-1)}`,
      sessionsDirtyFiles: new Set(),
      targetSessionFiles: null,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activePaths).toEqual(new Set(["sessions/a.jsonl", "sessions/b.jsonl"]));
    expect(plan.existingRows).toEqual([
      { hash: "hash-a", path: "sessions/a.jsonl" },
      { hash: "hash-b", path: "sessions/b.jsonl" },
    ]);
    expect(plan.existingHashes).toEqual(
      new Map([
        ["sessions/a.jsonl", "hash-a"],
        ["sessions/b.jsonl", "hash-b"],
      ]),
    );
  });

  it("treats targeted session syncs as refresh-only and skips unrelated pruning", () => {
    const plan = resolveMemorySessionSyncPlan({
      existingRows: [
        { hash: "hash-first", path: "sessions/targeted-first.jsonl" },
        { hash: "hash-second", path: "sessions/targeted-second.jsonl" },
      ],
      files: ["/tmp/targeted-first.jsonl"],
      needsFullReindex: false,
      sessionPathForFile: (file) => `sessions/${file.split("/").at(-1)}`,
      sessionsDirtyFiles: new Set(["/tmp/targeted-first.jsonl"]),
      targetSessionFiles: new Set(["/tmp/targeted-first.jsonl"]),
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activePaths).toBeNull();
    expect(plan.existingRows).toBeNull();
    expect(plan.existingHashes).toBeNull();
  });

  it("keeps dirty-only incremental mode when no targeted sync is requested", () => {
    const plan = resolveMemorySessionSyncPlan({
      existingRows: [],
      files: ["/tmp/incremental.jsonl"],
      needsFullReindex: false,
      sessionPathForFile: (file) => `sessions/${file.split("/").at(-1)}`,
      sessionsDirtyFiles: new Set(["/tmp/incremental.jsonl"]),
      targetSessionFiles: null,
    });

    expect(plan.indexAll).toBe(false);
    expect(plan.activePaths).toEqual(new Set(["sessions/incremental.jsonl"]));
  });
});
