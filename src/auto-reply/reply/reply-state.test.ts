import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  HISTORY_CONTEXT_MARKER,
  appendHistoryEntry,
  buildHistoryContext,
  buildHistoryContextFromEntries,
  buildHistoryContextFromMap,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "./history.js";
import {
  hasAlreadyFlushedForCurrentCompaction,
  resolveMemoryFlushContextWindowTokens,
  shouldRunMemoryFlush,
  shouldRunPreflightCompaction,
} from "./memory-flush.js";
import { CURRENT_MESSAGE_MARKER } from "./mentions.js";
import { incrementCompactionCount } from "./session-updates.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  entry: Record<string, unknown>;
}) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await fs.writeFile(
    params.storePath,
    JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
    "utf8",
  );
}

async function createCompactionSessionFixture(entry: SessionEntry) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-"));
  tempDirs.push(tmp);
  const storePath = path.join(tmp, "sessions.json");
  const sessionKey = "main";
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
  await seedSessionStore({ entry, sessionKey, storePath });
  return { sessionKey, sessionStore, storePath };
}

async function rotateCompactionSessionFile(params: {
  tempPrefix: string;
  sessionFile: (tmp: string) => string;
  newSessionId: string;
}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), params.tempPrefix));
  tempDirs.push(tmp);
  const storePath = path.join(tmp, "sessions.json");
  const sessionKey = "main";
  const entry = {
    compactionCount: 0,
    sessionFile: params.sessionFile(tmp),
    sessionId: "s1",
    updatedAt: Date.now(),
  } as SessionEntry;
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
  await seedSessionStore({ entry, sessionKey, storePath });
  await incrementCompactionCount({
    newSessionId: params.newSessionId,
    sessionEntry: entry,
    sessionKey,
    sessionStore,
    storePath,
  });
  const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
  const expectedDir = await fs.realpath(tmp);
  return { expectedDir, sessionKey, stored };
}

describe("history helpers", () => {
  function createHistoryMapWithTwoEntries() {
    const historyMap = new Map<string, { sender: string; body: string }[]>();
    historyMap.set("group", [
      { body: "one", sender: "A" },
      { body: "two", sender: "B" },
    ]);
    return historyMap;
  }

  it("returns current message when history is empty", () => {
    const result = buildHistoryContext({
      currentMessage: "hello",
      historyText: "  ",
    });
    expect(result).toBe("hello");
  });

  it("wraps history entries and excludes current by default", () => {
    const result = buildHistoryContextFromEntries({
      currentMessage: "current",
      entries: [
        { body: "one", sender: "A" },
        { body: "two", sender: "B" },
      ],
      formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
    });

    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).not.toContain("B: two");
    expect(result).toContain(CURRENT_MESSAGE_MARKER);
    expect(result).toContain("current");
  });

  it("trims history to configured limit", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    appendHistoryEntry({
      entry: { body: "one", sender: "A" },
      historyKey: "group",
      historyMap,
      limit: 2,
    });
    appendHistoryEntry({
      entry: { body: "two", sender: "B" },
      historyKey: "group",
      historyMap,
      limit: 2,
    });
    appendHistoryEntry({
      entry: { body: "three", sender: "C" },
      historyKey: "group",
      historyMap,
      limit: 2,
    });

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["two", "three"]);
  });

  it("builds context from map and appends entry", () => {
    const historyMap = createHistoryMapWithTwoEntries();

    const result = buildHistoryContextFromMap({
      currentMessage: "current",
      entry: { body: "three", sender: "C" },
      formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
      historyKey: "group",
      historyMap,
      limit: 3,
    });

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two", "three"]);
    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).toContain("B: two");
    expect(result).not.toContain("C: three");
  });

  it("builds context from pending map without appending", () => {
    const historyMap = createHistoryMapWithTwoEntries();

    const result = buildPendingHistoryContextFromMap({
      currentMessage: "current",
      formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
      historyKey: "group",
      historyMap,
      limit: 3,
    });

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two"]);
    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).toContain("B: two");
    expect(result).toContain(CURRENT_MESSAGE_MARKER);
    expect(result).toContain("current");
  });

  it("records pending entries only when enabled", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    recordPendingHistoryEntryIfEnabled({
      entry: { body: "one", sender: "A" },
      historyKey: "group",
      historyMap,
      limit: 0,
    });
    expect(historyMap.get("group")).toEqual(undefined);

    recordPendingHistoryEntryIfEnabled({
      entry: null,
      historyKey: "group",
      historyMap,
      limit: 2,
    });
    expect(historyMap.get("group")).toEqual(undefined);

    recordPendingHistoryEntryIfEnabled({
      entry: { body: "two", sender: "B" },
      historyKey: "group",
      historyMap,
      limit: 2,
    });
    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["two"]);
  });

  it("clears history entries only when enabled", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();
    historyMap.set("group", [
      { body: "one", sender: "A" },
      { body: "two", sender: "B" },
    ]);

    clearHistoryEntriesIfEnabled({ historyKey: "group", historyMap, limit: 0 });
    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two"]);

    clearHistoryEntriesIfEnabled({ historyKey: "group", historyMap, limit: 2 });
    expect(historyMap.get("group")).toEqual([]);
  });
});

describe("shouldRunMemoryFlush", () => {
  it("requires totalTokens and threshold", () => {
    expect(
      shouldRunMemoryFlush({
        contextWindowTokens: 16_000,
        entry: { totalTokens: 0 },
        reserveTokensFloor: 20_000,
        softThresholdTokens: 4000,
      }),
    ).toBe(false);
  });

  it("skips when entry is missing", () => {
    expect(
      shouldRunMemoryFlush({
        contextWindowTokens: 16_000,
        entry: undefined,
        reserveTokensFloor: 1000,
        softThresholdTokens: 4000,
      }),
    ).toBe(false);
  });

  it("skips when under threshold", () => {
    expect(
      shouldRunMemoryFlush({
        contextWindowTokens: 100_000,
        entry: { totalTokens: 10_000 },
        reserveTokensFloor: 20_000,
        softThresholdTokens: 10_000,
      }),
    ).toBe(false);
  });

  it("triggers at the threshold boundary", () => {
    expect(
      shouldRunMemoryFlush({
        contextWindowTokens: 100,
        entry: { totalTokens: 85 },
        reserveTokensFloor: 10,
        softThresholdTokens: 5,
      }),
    ).toBe(true);
  });

  it("skips when already flushed for current compaction count", () => {
    expect(
      shouldRunMemoryFlush({
        contextWindowTokens: 100_000,
        entry: {
          compactionCount: 2,
          memoryFlushCompactionCount: 2,
          totalTokens: 90_000,
        },
        reserveTokensFloor: 5000,
        softThresholdTokens: 2000,
      }),
    ).toBe(false);
  });

  it("runs when above threshold and not flushed", () => {
    expect(
      shouldRunMemoryFlush({
        contextWindowTokens: 100_000,
        entry: { compactionCount: 1, totalTokens: 96_000 },
        reserveTokensFloor: 5000,
        softThresholdTokens: 2000,
      }),
    ).toBe(true);
  });

  it("ignores stale cached totals", () => {
    expect(
      shouldRunMemoryFlush({
        contextWindowTokens: 100_000,
        entry: { compactionCount: 1, totalTokens: 96_000, totalTokensFresh: false },
        reserveTokensFloor: 5000,
        softThresholdTokens: 2000,
      }),
    ).toBe(false);
  });
});

describe("shouldRunPreflightCompaction", () => {
  it("ignores stale cached totals when no projected token count is provided", () => {
    expect(
      shouldRunPreflightCompaction({
        contextWindowTokens: 100_000,
        entry: { totalTokens: 96_000, totalTokensFresh: false },
        reserveTokensFloor: 5000,
        softThresholdTokens: 2000,
      }),
    ).toBe(false);
  });

  it("triggers when a projected token count crosses the threshold", () => {
    expect(
      shouldRunPreflightCompaction({
        contextWindowTokens: 100_000,
        entry: { totalTokens: 10, totalTokensFresh: false },
        reserveTokensFloor: 5000,
        softThresholdTokens: 2000,
        tokenCount: 93_000,
      }),
    ).toBe(true);
  });
});

describe("hasAlreadyFlushedForCurrentCompaction", () => {
  it("returns true when memoryFlushCompactionCount matches compactionCount", () => {
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        compactionCount: 3,
        memoryFlushCompactionCount: 3,
      }),
    ).toBe(true);
  });

  it("returns false when memoryFlushCompactionCount differs", () => {
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        compactionCount: 3,
        memoryFlushCompactionCount: 2,
      }),
    ).toBe(false);
  });

  it("returns false when memoryFlushCompactionCount is undefined", () => {
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        compactionCount: 1,
      }),
    ).toBe(false);
  });

  it("treats missing compactionCount as 0", () => {
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        memoryFlushCompactionCount: 0,
      }),
    ).toBe(true);
  });
});

describe("resolveMemoryFlushContextWindowTokens", () => {
  it("falls back to agent config or default tokens", () => {
    expect(resolveMemoryFlushContextWindowTokens({ agentCfgContextTokens: 42_000 })).toBe(42_000);
  });

  it("uses provider-specific configured limits when the same model id exists on multiple providers", () => {
    const cfg = {
      models: {
        providers: {
          "provider-a": { models: [{ contextWindow: 200_000, id: "shared-model" }] },
          "provider-b": { models: [{ contextWindow: 512_000, id: "shared-model" }] },
        },
      },
    };
    expect(
      resolveMemoryFlushContextWindowTokens({
        cfg: cfg as never,
        modelId: "shared-model",
        provider: "provider-b",
      }),
    ).toBe(512_000);
    expect(
      resolveMemoryFlushContextWindowTokens({
        cfg: cfg as never,
        modelId: "shared-model",
        provider: "provider-a",
      }),
    ).toBe(200_000);
  });

  it("prefers agent contextTokens override over the provider configured window", () => {
    const cfg = {
      models: {
        providers: {
          "provider-b": { models: [{ contextWindow: 512_000, id: "shared-model" }] },
        },
      },
    };
    expect(
      resolveMemoryFlushContextWindowTokens({
        agentCfgContextTokens: 100_000,
        cfg: cfg as never,
        modelId: "shared-model",
        provider: "provider-b",
      }),
    ).toBe(100_000);
  });
});

describe("incrementCompactionCount", () => {
  it("increments compaction count", async () => {
    const entry = { compactionCount: 2, sessionId: "s1", updatedAt: Date.now() } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    const count = await incrementCompactionCount({
      sessionEntry: entry,
      sessionKey,
      sessionStore,
      storePath,
    });
    expect(count).toBe(3);

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].compactionCount).toBe(3);
  });

  it("updates totalTokens when tokensAfter is provided", async () => {
    const entry = {
      compactionCount: 0,
      inputTokens: 170_000,
      outputTokens: 10_000,
      sessionId: "s1",
      totalTokens: 180_000,
      updatedAt: Date.now(),
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionKey,
      sessionStore,
      storePath,
      tokensAfter: 12_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].compactionCount).toBe(1);
    expect(stored[sessionKey].totalTokens).toBe(12_000);
    // Input/output cleared since we only have the total estimate
    expect(stored[sessionKey].inputTokens).toBeUndefined();
    expect(stored[sessionKey].outputTokens).toBeUndefined();
  });

  it("updates sessionId and sessionFile when compaction rotated transcripts", async () => {
    const { stored, sessionKey, expectedDir } = await rotateCompactionSessionFile({
      newSessionId: "s2",
      sessionFile: (tmp) => path.join(tmp, "s1-topic-456.jsonl"),
      tempPrefix: "openclaw-compact-rotate-",
    });
    expect(stored[sessionKey].sessionId).toBe("s2");
    expect(stored[sessionKey].sessionFile).toBe(path.join(expectedDir, "s2-topic-456.jsonl"));
  });

  it("preserves fork transcript filenames when compaction rotates transcripts", async () => {
    const { stored, sessionKey, expectedDir } = await rotateCompactionSessionFile({
      newSessionId: "s2",
      sessionFile: (tmp) => path.join(tmp, "2026-03-23T12-34-56-789Z_s1.jsonl"),
      tempPrefix: "openclaw-compact-fork-",
    });
    expect(stored[sessionKey].sessionId).toBe("s2");
    expect(stored[sessionKey].sessionFile).toBe(
      path.join(expectedDir, "2026-03-23T12-34-56-789Z_s2.jsonl"),
    );
  });

  it("keeps rewritten absolute sessionFile paths that stay inside the sessions directory", async () => {
    const { stored, sessionKey, expectedDir } = await rotateCompactionSessionFile({
      newSessionId: "s2",
      sessionFile: (tmp) => path.join(tmp, "outside", "s1.jsonl"),
      tempPrefix: "openclaw-compact-unsafe-",
    });
    expect(stored[sessionKey].sessionId).toBe("s2");
    expect(stored[sessionKey].sessionFile).toBe(path.join(expectedDir, "outside", "s2.jsonl"));
  });

  it("increments compaction count by an explicit amount", async () => {
    const entry = { compactionCount: 2, sessionId: "s1", updatedAt: Date.now() } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    const count = await incrementCompactionCount({
      amount: 2,
      sessionEntry: entry,
      sessionKey,
      sessionStore,
      storePath,
    });
    expect(count).toBe(4);

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].compactionCount).toBe(4);
  });

  it("updates sessionId and sessionFile when newSessionId is provided", async () => {
    const entry = {
      compactionCount: 1,
      sessionFile: "old-session-id.jsonl",
      sessionId: "old-session-id",
      updatedAt: Date.now(),
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementCompactionCount({
      newSessionId: "new-session-id",
      sessionEntry: entry,
      sessionKey,
      sessionStore,
      storePath,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    const expectedSessionDir = await fs.realpath(path.dirname(storePath));
    expect(stored[sessionKey].sessionId).toBe("new-session-id");
    expect(stored[sessionKey].sessionFile).toBe(
      path.join(expectedSessionDir, "new-session-id.jsonl"),
    );
    expect(stored[sessionKey].compactionCount).toBe(2);
  });

  it("does not update sessionFile when newSessionId matches current sessionId", async () => {
    const entry = {
      compactionCount: 0,
      sessionFile: "same-id.jsonl",
      sessionId: "same-id",
      updatedAt: Date.now(),
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementCompactionCount({
      newSessionId: "same-id",
      sessionEntry: entry,
      sessionKey,
      sessionStore,
      storePath,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].sessionId).toBe("same-id");
    expect(stored[sessionKey].sessionFile).toBe("same-id.jsonl");
    expect(stored[sessionKey].compactionCount).toBe(1);
  });

  it("does not update totalTokens when tokensAfter is not provided", async () => {
    const entry = {
      compactionCount: 0,
      sessionId: "s1",
      totalTokens: 180_000,
      updatedAt: Date.now(),
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionKey,
      sessionStore,
      storePath,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].compactionCount).toBe(1);
    // TotalTokens unchanged
    expect(stored[sessionKey].totalTokens).toBe(180_000);
  });
});
