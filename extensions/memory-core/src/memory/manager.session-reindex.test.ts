import { describe, expect, it } from "vitest";
import { shouldSyncSessionsForReindex } from "./manager-session-reindex.js";

describe("memory manager session reindex gating", () => {
  it("keeps session syncing enabled for full reindexes triggered from session-start/watch", () => {
    expect(
      shouldSyncSessionsForReindex({
        dirtySessionFileCount: 0,
        hasSessionSource: true,
        needsFullReindex: true,
        sessionsDirty: false,
        sync: { reason: "session-start" },
      }),
    ).toBe(true);
    expect(
      shouldSyncSessionsForReindex({
        dirtySessionFileCount: 0,
        hasSessionSource: true,
        needsFullReindex: true,
        sessionsDirty: false,
        sync: { reason: "watch" },
      }),
    ).toBe(true);
    expect(
      shouldSyncSessionsForReindex({
        dirtySessionFileCount: 0,
        hasSessionSource: true,
        needsFullReindex: false,
        sessionsDirty: false,
        sync: { reason: "session-start" },
      }),
    ).toBe(false);
    expect(
      shouldSyncSessionsForReindex({
        dirtySessionFileCount: 0,
        hasSessionSource: true,
        needsFullReindex: false,
        sessionsDirty: false,
        sync: { reason: "watch" },
      }),
    ).toBe(false);
  });
});
