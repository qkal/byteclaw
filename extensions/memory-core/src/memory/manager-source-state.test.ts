import { describe, expect, it } from "vitest";
import {
  MEMORY_SOURCE_FILE_HASH_SQL,
  MEMORY_SOURCE_FILE_STATE_SQL,
  loadMemorySourceFileState,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";

describe("memory source state", () => {
  it("loads source hashes with one bulk query", () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const state = loadMemorySourceFileState({
      db: {
        prepare: (sql) => ({
          all: (...args) => {
            calls.push({ args, sql });
            return [
              { hash: "hash-1", path: "memory/one.md" },
              { hash: "hash-2", path: "memory/two.md" },
            ];
          },
          get: () => undefined,
        }),
      },
      source: "memory",
    });

    expect(calls).toEqual([{ args: ["memory"], sql: MEMORY_SOURCE_FILE_STATE_SQL }]);
    expect(state.rows).toEqual([
      { hash: "hash-1", path: "memory/one.md" },
      { hash: "hash-2", path: "memory/two.md" },
    ]);
    expect(state.hashes).toEqual(
      new Map([
        ["memory/one.md", "hash-1"],
        ["memory/two.md", "hash-2"],
      ]),
    );
  });

  it("uses bulk snapshot hashes when present", () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const hash = resolveMemorySourceExistingHash({
      db: {
        prepare: (sql) => ({
          all: () => [],
          get: (...args) => {
            calls.push({ args, sql });
            return { hash: "unexpected" };
          },
        }),
      },
      existingHashes: new Map([["sessions/thread.jsonl", "hash-from-snapshot"]]),
      path: "sessions/thread.jsonl",
      source: "sessions",
    });

    expect(hash).toBe("hash-from-snapshot");
    expect(calls).toEqual([]);
  });

  it("falls back to per-file lookups without a bulk snapshot", () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const hash = resolveMemorySourceExistingHash({
      db: {
        prepare: (sql) => ({
          all: () => [],
          get: (...args) => {
            calls.push({ args, sql });
            return { hash: "hash-from-row" };
          },
        }),
      },
      existingHashes: null,
      path: "sessions/thread.jsonl",
      source: "sessions",
    });

    expect(hash).toBe("hash-from-row");
    expect(calls).toEqual([
      {
        args: ["sessions/thread.jsonl", "sessions"],
        sql: MEMORY_SOURCE_FILE_HASH_SQL,
      },
    ]);
  });
});
