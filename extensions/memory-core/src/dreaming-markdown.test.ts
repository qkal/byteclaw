import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeDailyDreamingPhaseBlock, writeDeepDreamingReport } from "./dreaming-markdown.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

describe("dreaming markdown storage", () => {
  const nowMs = Date.parse("2026-04-05T10:00:00Z");
  const timezone = "UTC";

  it("writes inline light dreaming output into the daily memory file", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const result = await writeDailyDreamingPhaseBlock({
      bodyLines: ["- Candidate: remember the API key is fake"],
      nowMs,
      phase: "light",
      storage: {
        mode: "inline",
        separateReports: false,
      },
      timezone,
      workspaceDir,
    });

    expect(result.inlinePath).toBe(path.join(workspaceDir, "memory", "2026-04-05.md"));
    const content = await fs.readFile(result.inlinePath!, "utf8");
    expect(content).toContain("## Light Sleep");
    expect(content).toContain("- Candidate: remember the API key is fake");
  });

  it("keeps multiple inline phases in the shared daily memory file", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    await writeDailyDreamingPhaseBlock({
      bodyLines: ["- Candidate: first block"],
      nowMs,
      phase: "light",
      storage: {
        mode: "inline",
        separateReports: false,
      },
      timezone,
      workspaceDir,
    });
    await writeDailyDreamingPhaseBlock({
      bodyLines: ["- Theme: `focus` kept surfacing."],
      nowMs,
      phase: "rem",
      storage: {
        mode: "inline",
        separateReports: false,
      },
      timezone,
      workspaceDir,
    });

    const dreamsPath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const content = await fs.readFile(dreamsPath, "utf8");
    expect(content).toContain("## Light Sleep");
    expect(content).toContain("## REM Sleep");
    expect(content).toContain("- Candidate: first block");
    expect(content).toContain("- Theme: `focus` kept surfacing.");
  });

  it("keeps daily phase output separate from lowercase dreams.md diaries", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const lowercasePath = path.join(workspaceDir, "dreams.md");
    await fs.writeFile(lowercasePath, "# Scratch\n\n", "utf8");

    const result = await writeDailyDreamingPhaseBlock({
      bodyLines: ["- Theme: `glacier` kept surfacing."],
      nowMs,
      phase: "rem",
      storage: {
        mode: "inline",
        separateReports: false,
      },
      timezone,
      workspaceDir,
    });

    expect(result.inlinePath).toBe(path.join(workspaceDir, "memory", "2026-04-05.md"));
    const content = await fs.readFile(result.inlinePath!, "utf8");
    expect(content).toContain("## REM Sleep");
    expect(content).toContain("- Theme: `glacier` kept surfacing.");
    await expect(fs.readFile(lowercasePath, "utf8")).resolves.toBe("# Scratch\n\n");
  });

  it("still writes deep reports to the per-phase report directory", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const reportPath = await writeDeepDreamingReport({
      bodyLines: ["- Promoted: durable preference"],
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      storage: {
        mode: "separate",
        separateReports: false,
      },
      timezone: "UTC",
      workspaceDir,
    });

    expect(reportPath).toBe(path.join(workspaceDir, "memory", "dreaming", "deep", "2026-04-05.md"));
    const content = await fs.readFile(reportPath!, "utf8");
    expect(content).toContain("# Deep Sleep");
    expect(content).toContain("- Promoted: durable preference");

    await expect(fs.access(path.join(workspaceDir, "DREAMS.md"))).rejects.toThrow();
  });
});
