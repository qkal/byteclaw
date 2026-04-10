import fs from "node:fs/promises";
import path from "node:path";
import { readMemoryHostEvents } from "openclaw/plugin-sdk/memory-host-events";
import { describe, expect, it } from "vitest";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

describe("memory host event journal integration", () => {
  it("records recall and promotion events from short-term promotion flows", async () => {
    const workspaceDir = await createTempWorkspace("memory-core-events-");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      "# Daily\n\nalpha\nbeta\ngamma\n",
      "utf8",
    );

    await recordShortTermRecalls({
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
      query: "alpha memory",
      results: [
        {
          endLine: 4,
          path: "memory/2026-04-05.md",
          score: 0.92,
          snippet: "alpha beta",
          source: "memory",
          startLine: 3,
        },
      ],
      workspaceDir,
    });

    const candidates = await rankShortTermPromotionCandidates({
      minRecallCount: 0,
      minScore: 0,
      minUniqueQueries: 0,
      nowMs: Date.UTC(2026, 3, 5, 12, 5, 0),
      workspaceDir,
    });
    const applied = await applyShortTermPromotions({
      candidates,
      minRecallCount: 0,
      minScore: 0,
      minUniqueQueries: 0,
      nowMs: Date.UTC(2026, 3, 5, 12, 10, 0),
      workspaceDir,
    });

    expect(applied.applied).toBe(1);

    const events = await readMemoryHostEvents({ workspaceDir });

    expect(events.map((event) => event.type)).toEqual([
      "memory.recall.recorded",
      "memory.promotion.applied",
    ]);
    expect(events[0]).toMatchObject({
      query: "alpha memory",
      resultCount: 1,
      type: "memory.recall.recorded",
    });
    expect(events[1]).toMatchObject({
      applied: 1,
      type: "memory.promotion.applied",
    });
  });

  it("records dreaming completion events when phase artifacts are written", async () => {
    const workspaceDir = await createTempWorkspace("memory-core-dream-events-");

    const written = await writeDailyDreamingPhaseBlock({
      bodyLines: ["- staged note", "- second note"],
      nowMs: Date.UTC(2026, 3, 5, 13, 0, 0),
      phase: "light",
      storage: { mode: "both", separateReports: true },
      workspaceDir,
    });

    const events = await readMemoryHostEvents({ workspaceDir });

    expect(written.inlinePath).toBeTruthy();
    expect(written.reportPath).toBeTruthy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      lineCount: 2,
      phase: "light",
      storageMode: "both",
      type: "memory.dream.completed",
    });
  });
});
