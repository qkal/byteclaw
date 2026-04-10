import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendMemoryHostEvent,
  readMemoryHostEvents,
  resolveMemoryHostEventLogPath,
} from "./memory-host-events.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDir } = createPluginSdkTestHarness();

describe("memory host event journal helpers", () => {
  it("appends and reads typed workspace events", async () => {
    const workspaceDir = await createTempDir("memory-host-events-");

    await appendMemoryHostEvent(workspaceDir, {
      query: "glacier backup",
      resultCount: 1,
      results: [
        {
          endLine: 3,
          path: "memory/2026-04-05.md",
          score: 0.9,
          startLine: 1,
        },
      ],
      timestamp: "2026-04-05T12:00:00.000Z",
      type: "memory.recall.recorded",
    });
    await appendMemoryHostEvent(workspaceDir, {
      inlinePath: path.join(workspaceDir, "memory", "2026-04-05.md"),
      lineCount: 4,
      phase: "light",
      reportPath: path.join(workspaceDir, "memory", "dreaming", "light", "2026-04-05.md"),
      storageMode: "both",
      timestamp: "2026-04-05T13:00:00.000Z",
      type: "memory.dream.completed",
    });

    const eventLogPath = resolveMemoryHostEventLogPath(workspaceDir);
    await expect(fs.readFile(eventLogPath, "utf8")).resolves.toContain(
      '"type":"memory.recall.recorded"',
    );

    const events = await readMemoryHostEvents({ workspaceDir });
    const tail = await readMemoryHostEvents({ limit: 1, workspaceDir });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("memory.recall.recorded");
    expect(events[1]?.type).toBe("memory.dream.completed");
    expect(tail).toHaveLength(1);
    expect(tail[0]?.type).toBe("memory.dream.completed");
  });
});
