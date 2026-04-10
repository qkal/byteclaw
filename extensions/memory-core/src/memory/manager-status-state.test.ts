import type { SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MEMORY_STATUS_AGGREGATE_SQL,
  collectMemoryStatusAggregate,
  resolveInitialMemoryDirty,
  resolveStatusProviderInfo,
} from "./manager-status-state.js";

describe("memory manager status state", () => {
  it("keeps memory clean for status-only managers after prior indexing", () => {
    expect(
      resolveInitialMemoryDirty({
        hasIndexedMeta: true,
        hasMemorySource: true,
        statusOnly: true,
      }),
    ).toBe(false);
  });

  it("marks status-only managers dirty when no prior index metadata exists", () => {
    expect(
      resolveInitialMemoryDirty({
        hasIndexedMeta: false,
        hasMemorySource: true,
        statusOnly: true,
      }),
    ).toBe(true);
  });

  it("reports the requested provider before provider initialization", () => {
    expect(
      resolveStatusProviderInfo({
        configuredModel: "mock-embed",
        provider: null,
        providerInitialized: false,
        requestedProvider: "openai",
      }),
    ).toEqual({
      model: "mock-embed",
      provider: "openai",
      searchMode: "hybrid",
    });
  });

  it("reports fts-only mode when initialization finished without a provider", () => {
    expect(
      resolveStatusProviderInfo({
        configuredModel: "mock-embed",
        provider: null,
        providerInitialized: true,
        requestedProvider: "openai",
      }),
    ).toEqual({
      model: undefined,
      provider: "none",
      searchMode: "fts-only",
    });
  });

  it("uses one aggregation query for status counts and source breakdowns", () => {
    const calls: { sql: string; params: SQLInputValue[] }[] = [];
    const aggregate = collectMemoryStatusAggregate({
      db: {
        prepare: (sql) => ({
          all: (...params) => {
            calls.push({ params, sql });
            return [
              { c: 2, kind: "files" as const, source: "memory" as const },
              { c: 5, kind: "chunks" as const, source: "memory" as const },
              { c: 1, kind: "files" as const, source: "sessions" as const },
              { c: 3, kind: "chunks" as const, source: "sessions" as const },
            ];
          },
        }),
      },
      sourceFilterParams: ["memory", "sessions"],
      sourceFilterSql: " AND source IN (?, ?)",
      sources: ["memory", "sessions"],
    });

    expect(calls).toEqual([
      {
        params: ["memory", "sessions", "memory", "sessions"],
        sql: MEMORY_STATUS_AGGREGATE_SQL.replaceAll("__FILTER__", " AND source IN (?, ?)"),
      },
    ]);
    expect(aggregate).toEqual({
      chunks: 8,
      files: 3,
      sourceCounts: [
        { chunks: 5, files: 2, source: "memory" },
        { chunks: 3, files: 1, source: "sessions" },
      ],
    });
  });
});
