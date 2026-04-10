import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

import {
  applyShortTermPromotions,
  auditShortTermPromotionArtifacts,
  isShortTermMemoryPath,
  recordGroundedShortTermCandidates,
  rankShortTermPromotionCandidates,
  recordDreamingPhaseSignals,
  recordShortTermRecalls,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
  resolveShortTermRecallLockPath,
  resolveShortTermPhaseSignalStorePath,
  resolveShortTermRecallStorePath,
  __testing,
} from "./short-term-promotion.js";

describe("short-term promotion", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  });

  async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    await run(workspaceDir);
  }

  async function writeDailyMemoryNote(
    workspaceDir: string,
    date: string,
    lines: string[],
  ): Promise<string> {
    const notePath = path.join(workspaceDir, "memory", `${date}.md`);
    await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf8");
    return notePath;
  }

  it("detects short-term daily memory paths", () => {
    expect(isShortTermMemoryPath("memory/2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("memory/.dreams/session-corpus/2026-04-03.txt")).toBe(true);
    expect(isShortTermMemoryPath("notes/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("MEMORY.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/network.md")).toBe(false);
  });

  it("records recalls and ranks candidates with weighted scores", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        query: "router",
        results: [
          {
            endLine: 5,
            path: "memory/2026-04-02.md",
            score: 0.9,
            snippet: "Configured VLAN 10 on Omada router",
            source: "memory",
            startLine: 3,
          },
          {
            endLine: 1,
            path: "MEMORY.md",
            score: 0.99,
            snippet: "Long-term note",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });
      await recordShortTermRecalls({
        query: "iot vlan",
        results: [
          {
            endLine: 5,
            path: "memory/2026-04-02.md",
            score: 0.8,
            snippet: "Configured VLAN 10 on Omada router",
            source: "memory",
            startLine: 3,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.path).toBe("memory/2026-04-02.md");
      expect(ranked[0]?.recallCount).toBe(2);
      expect(ranked[0]?.uniqueQueries).toBe(2);
      expect(ranked[0]?.score).toBeGreaterThan(0);
      expect(ranked[0]?.conceptTags).toContain("router");
      expect(ranked[0]?.components.conceptual).toBeGreaterThan(0);

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const raw = await fs.readFile(storePath, "utf8");
      expect(raw).toContain("memory/2026-04-02.md");
      expect(raw).not.toContain("Long-term note");
    });
  });

  it("serializes concurrent recall writes so counts are not lost", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          recordShortTermRecalls({
            query: `backup-${index % 4}`,
            results: [
              {
                endLine: 2,
                path: "memory/2026-04-03.md",
                score: 0.9,
                snippet: "Move backups to S3 Glacier.",
                source: "memory",
                startLine: 1,
              },
            ],
            workspaceDir,
          }),
        ),
      );

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.recallCount).toBe(8);
      expect(ranked[0]?.uniqueQueries).toBe(4);
    });
  });

  it("uses default thresholds for promotion", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        query: "glacier",
        results: [
          {
            endLine: 2,
            path: "memory/2026-04-03.md",
            score: 0.96,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({ workspaceDir });
      expect(ranked).toHaveLength(0);
    });
  });

  it("lets grounded durable evidence satisfy default deep thresholds", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        'Always use "Happy Together" calendar for flights and reservations.',
      ]);

      await recordGroundedShortTermCandidates({
        dedupeByQueryPerDay: true,
        items: [
          {
            dayBucket: "2026-04-03",
            endLine: 1,
            path: "memory/2026-04-03.md",
            query: "__dreaming_grounded_backfill__:lasting-update",
            score: 0.92,
            signalCount: 2,
            snippet: 'Always use "Happy Together" calendar for flights and reservations.',
            startLine: 1,
          },
          {
            dayBucket: "2026-04-03",
            endLine: 1,
            path: "memory/2026-04-03.md",
            query: "__dreaming_grounded_backfill__:candidate",
            score: 0.82,
            signalCount: 1,
            snippet: 'Always use "Happy Together" calendar for flights and reservations.',
            startLine: 1,
          },
        ],
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
        query: "__dreaming_grounded_backfill__",
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
        workspaceDir,
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.groundedCount).toBe(3);
      expect(ranked[0]?.uniqueQueries).toBe(2);
      expect(ranked[0]?.avgScore).toBeGreaterThan(0.85);

      const applied = await applyShortTermPromotions({
        candidates: ranked,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
        workspaceDir,
      });

      expect(applied.applied).toBe(1);
      const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
      expect(memory).toContain('Always use "Happy Together" calendar');
    });
  });

  it("removes grounded-only staged entries without deleting mixed live entries", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        "Grounded only rule.",
        "Live recall-backed rule.",
      ]);

      await recordGroundedShortTermCandidates({
        dedupeByQueryPerDay: true,
        items: [
          {
            dayBucket: "2026-04-03",
            endLine: 1,
            path: "memory/2026-04-03.md",
            query: "__dreaming_grounded_backfill__:lasting-update",
            score: 0.92,
            signalCount: 2,
            snippet: "Grounded only rule.",
            startLine: 1,
          },
          {
            dayBucket: "2026-04-03",
            endLine: 2,
            path: "memory/2026-04-03.md",
            query: "__dreaming_grounded_backfill__:lasting-update",
            score: 0.92,
            signalCount: 2,
            snippet: "Live recall-backed rule.",
            startLine: 2,
          },
        ],
        query: "__dreaming_grounded_backfill__",
        workspaceDir,
      });
      await recordShortTermRecalls({
        query: "live recall",
        results: [
          {
            endLine: 2,
            path: "memory/2026-04-03.md",
            score: 0.87,
            snippet: "Live recall-backed rule.",
            source: "memory",
            startLine: 2,
          },
        ],
        workspaceDir,
      });

      const result = await removeGroundedShortTermCandidates({ workspaceDir });
      expect(result.removed).toBe(1);

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.snippet).toContain("Live recall-backed rule");
      expect(ranked[0]?.groundedCount).toBe(2);
      expect(ranked[0]?.recallCount).toBe(1);
    });
  });

  it("rewards spaced recalls as consolidation instead of only raw count", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        query: "router",
        results: [
          {
            endLine: 2,
            path: "memory/2026-04-01.md",
            score: 0.9,
            snippet: "Configured router VLAN 10 and IoT segment.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });
      await recordShortTermRecalls({
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        query: "iot segment",
        results: [
          {
            endLine: 2,
            path: "memory/2026-04-01.md",
            score: 0.88,
            snippet: "Configured router VLAN 10 and IoT segment.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
        workspaceDir,
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.recallDays).toEqual(["2026-04-01", "2026-04-04"]);
      expect(ranked[0]?.components.consolidation).toBeGreaterThan(0.4);
    });
  });

  it("lets recency half-life tune the temporal score", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        query: "glacier retention",
        results: [
          {
            endLine: 2,
            path: "memory/2026-04-01.md",
            score: 0.92,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });

      const slowerDecay = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
        recencyHalfLifeDays: 14,
        workspaceDir,
      });
      const fasterDecay = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
        recencyHalfLifeDays: 7,
        workspaceDir,
      });

      expect(slowerDecay).toHaveLength(1);
      expect(fasterDecay).toHaveLength(1);
      expect(slowerDecay[0]?.components.recency).toBeCloseTo(0.5, 3);
      expect(fasterDecay[0]?.components.recency).toBeCloseTo(0.25, 3);
      expect(slowerDecay[0].score).toBeGreaterThan(fasterDecay[0].score);
    });
  });

  it("boosts deep ranking when light/rem phase signals reinforce a candidate", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
      await recordShortTermRecalls({
        nowMs,
        query: "router setup",
        results: [
          {
            endLine: 1,
            path: "memory/2026-04-01.md",
            score: 0.75,
            snippet: "Router VLAN baseline noted.",
            source: "memory",
            startLine: 1,
          },
          {
            endLine: 1,
            path: "memory/2026-04-02.md",
            score: 0.75,
            snippet: "Backup policy for router snapshots.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });
      await recordShortTermRecalls({
        nowMs,
        query: "router backup",
        results: [
          {
            endLine: 1,
            path: "memory/2026-04-01.md",
            score: 0.75,
            snippet: "Router VLAN baseline noted.",
            source: "memory",
            startLine: 1,
          },
          {
            endLine: 1,
            path: "memory/2026-04-02.md",
            score: 0.75,
            snippet: "Backup policy for router snapshots.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });

      const baseline = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        nowMs,
        workspaceDir,
      });
      expect(baseline).toHaveLength(2);
      expect(baseline[0]?.path).toBe("memory/2026-04-01.md");

      const boostedKey = baseline.find((entry) => entry.path === "memory/2026-04-02.md")?.key;
      expect(boostedKey).toBeTruthy();
      await recordDreamingPhaseSignals({
        keys: [boostedKey!],
        nowMs,
        phase: "light",
        workspaceDir,
      });
      await recordDreamingPhaseSignals({
        keys: [boostedKey!],
        nowMs,
        phase: "rem",
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        nowMs,
        workspaceDir,
      });
      expect(ranked[0]?.path).toBe("memory/2026-04-02.md");
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);

      const phaseStorePath = resolveShortTermPhaseSignalStorePath(workspaceDir);
      const phaseStore = JSON.parse(await fs.readFile(phaseStorePath, "utf8")) as {
        entries: Record<string, { lightHits: number; remHits: number }>;
      };
      expect(phaseStore.entries[boostedKey!]).toMatchObject({
        lightHits: 1,
        remHits: 1,
      });
    });
  });

  it("weights fresh phase signals more than stale ones", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        query: "glacier cadence",
        results: [
          {
            endLine: 1,
            path: "memory/2026-04-01.md",
            score: 0.9,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });
      await recordShortTermRecalls({
        nowMs: Date.parse("2026-04-01T12:00:00.000Z"),
        query: "backup lifecycle",
        results: [
          {
            endLine: 1,
            path: "memory/2026-04-01.md",
            score: 0.9,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });

      const rankedBaseline = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
        workspaceDir,
      });
      const key = rankedBaseline[0]?.key;
      expect(key).toBeTruthy();

      await recordDreamingPhaseSignals({
        keys: [key],
        nowMs: Date.parse("2026-02-01T10:00:00.000Z"),
        phase: "rem",
        workspaceDir,
      });
      const staleSignalRank = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
        workspaceDir,
      });
      await recordDreamingPhaseSignals({
        keys: [key],
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
        phase: "rem",
        workspaceDir,
      });
      const freshSignalRank = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
        workspaceDir,
      });

      expect(staleSignalRank).toHaveLength(1);
      expect(freshSignalRank).toHaveLength(1);
      expect(freshSignalRank[0].score).toBeGreaterThan(staleSignalRank[0].score);
    });
  });

  it("reconciles existing promotion markers instead of appending duplicates", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "line 1",
        "line 2",
        "The gateway should stay loopback-only on port 18789.",
      ]);
      await recordShortTermRecalls({
        query: "gateway loopback",
        results: [
          {
            endLine: 3,
            path: "memory/2026-04-01.md",
            score: 0.95,
            snippet: "The gateway should stay loopback-only on port 18789.",
            source: "memory",
            startLine: 3,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      const firstApply = await applyShortTermPromotions({
        candidates: ranked,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      expect(firstApply.applied).toBe(1);
      expect(firstApply.appended).toBe(1);
      expect(firstApply.reconciledExisting).toBe(0);

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const rawStore = JSON.parse(await fs.readFile(storePath, "utf8")) as {
        entries: Record<string, { promotedAt?: string }>;
      };
      for (const entry of Object.values(rawStore.entries)) {
        delete entry.promotedAt;
      }
      await fs.writeFile(storePath, `${JSON.stringify(rawStore, null, 2)}\n`, "utf8");

      const secondApply = await applyShortTermPromotions({
        candidates: ranked,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      expect(secondApply.applied).toBe(1);
      expect(secondApply.appended).toBe(0);
      expect(secondApply.reconciledExisting).toBe(1);

      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
      expect(memoryText.match(/openclaw-memory-promotion:/g)?.length).toBe(1);
      expect(
        memoryText.match(/The gateway should stay loopback-only on port 18789\./g)?.length,
      ).toBe(1);
    });
  });

  it("filters out candidates older than maxAgeDays during ranking", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        query: "old note",
        results: [
          {
            endLine: 2,
            path: "memory/2026-04-01.md",
            score: 0.92,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        maxAgeDays: 7,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
        workspaceDir,
      });

      expect(ranked).toHaveLength(0);
    });
  });

  it("treats negative threshold overrides as invalid and keeps defaults", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        query: "glacier",
        results: [
          {
            endLine: 2,
            path: "memory/2026-04-03.md",
            score: 0.96,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: -1,
        minScore: -1,
        minUniqueQueries: -1,
        workspaceDir,
      });
      expect(ranked).toHaveLength(0);
    });
  });

  it("enforces default thresholds during apply even when candidates are passed directly", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const applied = await applyShortTermPromotions({
        candidates: [
          {
            ageDays: 0,
            avgScore: 0.95,
            components: {
              conceptual: 0.4,
              consolidation: 0.2,
              diversity: 0.2,
              frequency: 0.2,
              recency: 1,
              relevance: 0.95,
            },
            conceptTags: ["glacier", "backups"],
            endLine: 2,
            firstRecalledAt: new Date().toISOString(),
            key: "memory:memory/2026-04-03.md:1:2",
            lastRecalledAt: new Date().toISOString(),
            maxScore: 0.95,
            path: "memory/2026-04-03.md",
            recallCount: 1,
            recallDays: [new Date().toISOString().slice(0, 10)],
            score: 0.95,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
            startLine: 1,
            uniqueQueries: 1,
          },
        ],
        workspaceDir,
      });

      expect(applied.applied).toBe(0);
    });
  });

  it("skips direct candidates that exceed maxAgeDays during apply", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const applied = await applyShortTermPromotions({
        candidates: [
          {
            ageDays: 10,
            avgScore: 0.95,
            components: {
              conceptual: 1,
              consolidation: 1,
              diversity: 1,
              frequency: 1,
              recency: 1,
              relevance: 1,
            },
            conceptTags: ["expired"],
            endLine: 1,
            firstRecalledAt: "2026-04-01T00:00:00.000Z",
            key: "memory:memory/2026-04-01.md:1:1",
            lastRecalledAt: "2026-04-02T00:00:00.000Z",
            maxScore: 0.95,
            path: "memory/2026-04-01.md",
            recallCount: 3,
            recallDays: ["2026-04-01", "2026-04-02"],
            score: 0.95,
            snippet: "Expired short-term note.",
            source: "memory",
            startLine: 1,
            uniqueQueries: 2,
          },
        ],
        maxAgeDays: 7,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });

      expect(applied.applied).toBe(0);
      await expect(
        fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("applies promotion candidates to MEMORY.md and marks them promoted", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "alpha",
        "beta",
        "gamma",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta",
        "iota",
        "Gateway binds loopback and port 18789",
        "Keep gateway on localhost only",
        "Document healthcheck endpoint",
      ]);
      await recordShortTermRecalls({
        query: "gateway host",
        results: [
          {
            endLine: 12,
            path: "memory/2026-04-01.md",
            score: 0.92,
            snippet: "Gateway binds loopback and port 18789",
            source: "memory",
            startLine: 10,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      const applied = await applyShortTermPromotions({
        candidates: ranked,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      expect(applied.applied).toBe(1);

      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
      expect(memoryText).toContain("Promoted From Short-Term Memory");
      expect(memoryText).toContain("memory/2026-04-01.md:10-10");

      const rankedAfter = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      expect(rankedAfter).toHaveLength(0);

      const rankedIncludingPromoted = await rankShortTermPromotionCandidates({
        includePromoted: true,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      expect(rankedIncludingPromoted).toHaveLength(1);
      expect(rankedIncludingPromoted[0]?.promotedAt).toBeTruthy();
    });
  });

  it("does not re-append candidates that were promoted in a prior run", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "alpha",
        "beta",
        "gamma",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta",
        "iota",
        "Gateway binds loopback and port 18789",
        "Keep gateway on localhost only",
        "Document healthcheck endpoint",
      ]);
      await recordShortTermRecalls({
        query: "gateway host",
        results: [
          {
            endLine: 12,
            path: "memory/2026-04-01.md",
            score: 0.92,
            snippet: "Gateway binds loopback and port 18789",
            source: "memory",
            startLine: 10,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      const first = await applyShortTermPromotions({
        candidates: ranked,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      expect(first.applied).toBe(1);

      const second = await applyShortTermPromotions({
        candidates: ranked,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      expect(second.applied).toBe(0);

      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
      const sectionCount = memoryText.match(/Promoted From Short-Term Memory/g)?.length ?? 0;
      expect(sectionCount).toBe(1);
    });
  });

  it("rehydrates moved snippets from the live daily note before promotion", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "intro",
        "summary",
        "Moved backups to S3 Glacier.",
        "Keep cold storage retention at 365 days.",
      ]);
      await recordShortTermRecalls({
        query: "glacier",
        results: [
          {
            endLine: 1,
            path: "memory/2026-04-01.md",
            score: 0.94,
            snippet: "Moved backups to S3 Glacier.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      const applied = await applyShortTermPromotions({
        candidates: ranked,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.startLine).toBe(3);
      expect(applied.appliedCandidates[0]?.endLine).toBe(3);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
      expect(memoryText).toContain("memory/2026-04-01.md:3-3");
    });
  });

  it("prefers the nearest matching snippet when the same text appears multiple times", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "header",
        "Repeat backup note.",
        "gap",
        "gap",
        "gap",
        "gap",
        "gap",
        "gap",
        "Repeat backup note.",
      ]);
      await recordShortTermRecalls({
        query: "backup repeat",
        results: [
          {
            endLine: 9,
            path: "memory/2026-04-01.md",
            score: 0.9,
            snippet: "Repeat backup note.",
            source: "memory",
            startLine: 8,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      const applied = await applyShortTermPromotions({
        candidates: ranked,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.startLine).toBe(9);
      expect(applied.appliedCandidates[0]?.endLine).toBe(10);
    });
  });

  it("rehydrates legacy basename-only short-term paths from the memory directory", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Legacy basename path note."]);

      const applied = await applyShortTermPromotions({
        candidates: [
          {
            ageDays: 0,
            avgScore: 0.9,
            components: {
              conceptual: 0.3,
              consolidation: 0.5,
              diversity: 0.4,
              frequency: 0.3,
              recency: 1,
              relevance: 0.9,
            },
            conceptTags: ["legacy", "note"],
            endLine: 1,
            firstRecalledAt: "2026-04-01T00:00:00.000Z",
            key: "memory:2026-04-01.md:1:1",
            lastRecalledAt: "2026-04-02T00:00:00.000Z",
            maxScore: 0.95,
            path: "2026-04-01.md",
            recallCount: 2,
            recallDays: ["2026-04-01", "2026-04-02"],
            score: 0.9,
            snippet: "Legacy basename path note.",
            source: "memory",
            startLine: 1,
            uniqueQueries: 2,
          },
        ],
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });

      expect(applied.applied).toBe(1);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
      expect(memoryText).toContain("source=2026-04-01.md:1-1");
    });
  });

  it("skips promotion when the live daily note no longer contains the snippet", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Different note content now."]);
      await recordShortTermRecalls({
        query: "glacier",
        results: [
          {
            endLine: 1,
            path: "memory/2026-04-01.md",
            score: 0.94,
            snippet: "Moved backups to S3 Glacier.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      const applied = await applyShortTermPromotions({
        candidates: ranked,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });

      expect(applied.applied).toBe(0);
      await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("uses dreaming timezone for recall-day bucketing and promotion headers", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "Cross-midnight router maintenance window.",
      ]);
      await recordShortTermRecalls({
        nowMs: Date.parse("2026-04-01T23:30:00.000Z"),
        query: "router window",
        results: [
          {
            endLine: 1,
            path: "memory/2026-04-01.md",
            score: 0.9,
            snippet: "Cross-midnight router maintenance window.",
            source: "memory",
            startLine: 1,
          },
        ],
        timezone: "America/Los_Angeles",
        workspaceDir,
      });

      const ranked = await rankShortTermPromotionCandidates({
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        workspaceDir,
      });
      expect(ranked[0]?.recallDays).toEqual(["2026-04-01"]);

      const applied = await applyShortTermPromotions({
        candidates: ranked,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-02T06:30:00.000Z"),
        timezone: "America/Los_Angeles",
        workspaceDir,
      });

      expect(applied.applied).toBe(1);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
      expect(memoryText).toContain("Promoted From Short-Term Memory (2026-04-01)");
    });
  });

  it("audits and repairs invalid store metadata plus stale locks", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            entries: {
              bad: {
                path: "",
              },
              good: {
                endLine: 2,
                firstRecalledAt: "2026-04-01T00:00:00.000Z",
                key: "good",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                maxScore: 0.95,
                path: "memory/2026-04-01.md",
                queryHashes: ["a", "b"],
                recallCount: 2,
                snippet: "Gateway host uses qmd vector search for router notes.",
                source: "memory",
                startLine: 1,
                totalScore: 1.8,
              },
            },
            updatedAt: "2026-04-04T00:00:00.000Z",
            version: 1,
          },
          null,
          2,
        ),
        "utf8",
      );

      const lockPath = path.join(workspaceDir, "memory", ".dreams", "short-term-promotion.lock");
      await fs.writeFile(lockPath, "999999:0\n", "utf8");
      const staleMtime = new Date(Date.now() - 120_000);
      await fs.utimes(lockPath, staleMtime, staleMtime);

      const auditBefore = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(auditBefore.invalidEntryCount).toBe(1);
      expect(auditBefore.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["recall-store-invalid", "recall-lock-stale"]),
      );

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      expect(repair.removedStaleLock).toBe(true);

      const auditAfter = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(auditAfter.invalidEntryCount).toBe(0);
      expect(auditAfter.issues.map((issue) => issue.code)).not.toContain("recall-lock-stale");

      const repairedRaw = JSON.parse(await fs.readFile(storePath, "utf8")) as {
        entries: Record<string, { conceptTags?: string[]; recallDays?: string[] }>;
      };
      expect(repairedRaw.entries.good?.conceptTags).toContain("router");
      expect(repairedRaw.entries.good?.recallDays).toEqual(["2026-04-04"]);
    });
  });

  it("repairs empty recall-store files without throwing", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(storePath, "   \n", "utf8");

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      expect(JSON.parse(await fs.readFile(storePath, "utf8"))).toMatchObject({
        entries: {},
        version: 1,
      });
    });
  });

  it("does not rewrite an already normalized healthy recall store", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const snippet = "Gateway host uses qmd vector search for router notes.";
      const raw = `${JSON.stringify(
        {
          entries: {
            good: {
              conceptTags: __testing.deriveConceptTags({
                path: "memory/2026-04-01.md",
                snippet,
              }),
              dailyCount: 0,
              endLine: 2,
              firstRecalledAt: "2026-04-01T00:00:00.000Z",
              groundedCount: 0,
              key: "good",
              lastRecalledAt: "2026-04-04T00:00:00.000Z",
              maxScore: 0.95,
              path: "memory/2026-04-01.md",
              queryHashes: ["a", "b"],
              recallCount: 2,
              recallDays: ["2026-04-04"],
              snippet,
              source: "memory",
              startLine: 1,
              totalScore: 1.8,
            },
          },
          updatedAt: "2026-04-04T00:00:00.000Z",
          version: 1,
        },
        null,
        2,
      )}\n`;
      await fs.writeFile(storePath, raw, "utf8");

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(false);
      expect(repair.rewroteStore).toBe(false);
      const nextRaw = await fs.readFile(storePath, "utf8");
      expect(nextRaw).toBe(raw);
    });
  });

  it("waits for an active short-term lock before repairing", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const lockPath = resolveShortTermRecallLockPath(workspaceDir);
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            entries: {
              bad: {
                path: "",
              },
            },
            updatedAt: "2026-04-04T00:00:00.000Z",
            version: 1,
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.writeFile(lockPath, `${process.pid}:${Date.now()}\n`, "utf8");

      let settled = false;
      const repairPromise = repairShortTermPromotionArtifacts({ workspaceDir }).then((result) => {
        settled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 41));
      expect(settled).toBe(false);

      await fs.unlink(lockPath);
      const repair = await repairPromise;

      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      expect(repair.removedInvalidEntries).toBe(1);
    });
  });

  it("downgrades lock inspection failures into audit issues", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const lockPath = path.join(workspaceDir, "memory", ".dreams", "short-term-promotion.lock");
      const stat = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
        if (String(target) === lockPath) {
          const error = Object.assign(new Error("no access"), { code: "EACCES" });
          throw error;
        }
        return await vi
          .importActual<typeof import("node:fs/promises")>("node:fs/promises")
          .then((actual) => actual.stat(target));
      });
      try {
        const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
        expect(audit.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "recall-lock-unreadable",
              fixable: false,
            }),
          ]),
        );
      } finally {
        stat.mockRestore();
      }
    });
  });

  it("reports concept tag script coverage for multilingual recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        query: "routeur glacier",
        results: [
          {
            endLine: 2,
            path: "memory/2026-04-03.md",
            score: 0.93,
            snippet: "Configuration du routeur et sauvegarde Glacier.",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });
      await recordShortTermRecalls({
        query: "router cjk",
        results: [
          {
            endLine: 2,
            path: "memory/2026-04-04.md",
            score: 0.95,
            snippet: "障害対応ルーター設定とバックアップ確認。",
            source: "memory",
            startLine: 1,
          },
        ],
        workspaceDir,
      });

      const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(audit.conceptTaggedEntryCount).toBe(2);
      expect(audit.conceptTagScripts).toEqual({
        cjkEntryCount: 1,
        latinEntryCount: 1,
        mixedEntryCount: 0,
        otherEntryCount: 0,
      });
    });
  });

  it("extracts stable concept tags from snippets and paths", () => {
    expect(
      __testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "Move backups to S3 Glacier and sync QMD router notes.",
      }),
    ).toEqual(expect.arrayContaining(["glacier", "router", "backups"]));
  });

  it("extracts multilingual concept tags across latin and cjk snippets", () => {
    expect(
      __testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "Configuración du routeur et sauvegarde Glacier.",
      }),
    ).toEqual(expect.arrayContaining(["configuración", "routeur", "sauvegarde", "glacier"]));
    expect(
      __testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "障害対応ルーター設定とバックアップ確認。路由器备份与网关同步。",
      }),
    ).toEqual(expect.arrayContaining(["障害対応", "ルーター", "バックアップ", "路由器", "备份"]));
  });
});
