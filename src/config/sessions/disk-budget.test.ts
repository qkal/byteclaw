import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import type { SessionEntry } from "./types.js";

describe("enforceSessionDiskBudget", () => {
  it("does not treat referenced transcripts with marker-like session IDs as archived artifacts", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep.deleted.keep";
      const activeKey = "agent:main:main";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const store: Record<string, SessionEntry> = {
        [activeKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
      await fs.writeFile(transcriptPath, "x".repeat(256), "utf8");

      const result = await enforceSessionDiskBudget({
        activeSessionKey: activeKey,
        maintenance: {
          highWaterBytes: 100,
          maxDiskBytes: 150,
        },
        store,
        storePath,
        warnOnly: false,
      });

      await expect(fs.stat(transcriptPath)).resolves.toBeDefined();
      expect(result).toEqual(
        expect.objectContaining({
          removedFiles: 0,
        }),
      );
    });
  });

  it("removes true archived transcript artifacts while preserving referenced primary transcripts", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const archivePath = path.join(
        dir,
        `old-session.jsonl.deleted.${formatSessionArchiveTimestamp(Date.now() - 24 * 60 * 60 * 1000)}`,
      );
      const store: Record<string, SessionEntry> = {
        "agent:main:main": {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
      await fs.writeFile(transcriptPath, "k".repeat(80), "utf8");
      await fs.writeFile(archivePath, "a".repeat(260), "utf8");

      const result = await enforceSessionDiskBudget({
        maintenance: {
          highWaterBytes: 220,
          maxDiskBytes: 300,
        },
        store,
        storePath,
        warnOnly: false,
      });

      await expect(fs.stat(transcriptPath)).resolves.toBeDefined();
      await expect(fs.stat(archivePath)).rejects.toThrow();
      expect(result).toEqual(
        expect.objectContaining({
          removedEntries: 0,
          removedFiles: 1,
        }),
      );
    });
  });
});
