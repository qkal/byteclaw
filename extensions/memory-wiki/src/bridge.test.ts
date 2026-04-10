import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryPluginPublicArtifact } from "openclaw/plugin-sdk/memory-host-core";
import {
  appendMemoryHostEvent,
  resolveMemoryHostEventLogPath,
} from "openclaw/plugin-sdk/memory-host-events";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../../src/plugins/memory-state.js";
import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources } from "./bridge.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("syncMemoryWikiBridgeSources", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-bridge-suite-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  });

  afterEach(() => {
    clearMemoryPluginState();
  });

  function nextCaseRoot(name: string): string {
    return path.join(fixtureRoot, `case-${caseId++}-${name}`);
  }

  async function createBridgeWorkspace(name: string): Promise<string> {
    const workspaceDir = nextCaseRoot(name);
    await fs.mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  function registerBridgeArtifacts(artifacts: MemoryPluginPublicArtifact[]) {
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return artifacts;
        },
      },
    });
  }

  it("imports public memory artifacts and stays idempotent across reruns", async () => {
    const workspaceDir = await createBridgeWorkspace("workspace");
    const { rootDir: vaultDir, config } = await createVault({
      config: {
        bridge: {
          enabled: true,
          indexDailyNotes: true,
          indexDreamReports: true,
          indexMemoryRoot: true,
          readMemoryArtifacts: true,
        },
        vaultMode: "bridge",
      },
      rootDir: nextCaseRoot("vault"),
    });

    await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      "# Daily Note\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "dreaming", "2026-04-05.md"),
      "# Dream Report\n",
      "utf8",
    );
    registerBridgeArtifacts([
      {
        absolutePath: path.join(workspaceDir, "MEMORY.md"),
        agentIds: ["main"],
        contentType: "markdown",
        kind: "memory-root",
        relativePath: "MEMORY.md",
        workspaceDir,
      },
      {
        absolutePath: path.join(workspaceDir, "memory", "2026-04-05.md"),
        agentIds: ["main"],
        contentType: "markdown",
        kind: "daily-note",
        relativePath: "memory/2026-04-05.md",
        workspaceDir,
      },
      {
        absolutePath: path.join(workspaceDir, "memory", "dreaming", "2026-04-05.md"),
        agentIds: ["main"],
        contentType: "markdown",
        kind: "dream-report",
        relativePath: "memory/dreaming/2026-04-05.md",
        workspaceDir,
      },
    ]);

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ default: true, id: "main", workspace: workspaceDir }],
      },
    };

    const first = await syncMemoryWikiBridgeSources({ appConfig, config });

    expect(first.workspaces).toBe(1);
    expect(first.artifactCount).toBe(3);
    expect(first.importedCount).toBe(3);
    expect(first.updatedCount).toBe(0);
    expect(first.skippedCount).toBe(0);
    expect(first.removedCount).toBe(0);
    expect(first.pagePaths).toHaveLength(3);

    const sourcePages = await fs.readdir(path.join(vaultDir, "sources"));
    expect(sourcePages.filter((name) => name.startsWith("bridge-"))).toHaveLength(3);

    const memoryPage = await fs.readFile(path.join(vaultDir, first.pagePaths[0] ?? ""), "utf8");
    expect(memoryPage).toContain("sourceType: memory-bridge");
    expect(memoryPage).toContain("## Bridge Source");

    const second = await syncMemoryWikiBridgeSources({ appConfig, config });

    expect(second.importedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.skippedCount).toBe(3);
    expect(second.removedCount).toBe(0);

    const logLines = (await fs.readFile(path.join(vaultDir, ".openclaw-wiki", "log.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(logLines).toHaveLength(2);
  });

  it("returns a no-op result outside bridge mode", async () => {
    const { config } = await createVault({ rootDir: nextCaseRoot("isolated") });

    const result = await syncMemoryWikiBridgeSources({ config });

    expect(result).toMatchObject({
      artifactCount: 0,
      importedCount: 0,
      pagePaths: [],
      removedCount: 0,
      skippedCount: 0,
      updatedCount: 0,
      workspaces: 0,
    });
  });

  it("returns a no-op result when bridge mode is enabled without exported memory artifacts", async () => {
    const workspaceDir = await createBridgeWorkspace("no-memory-core");
    const { config } = await createVault({
      config: {
        bridge: {
          enabled: true,
          indexMemoryRoot: true,
          readMemoryArtifacts: true,
        },
        vaultMode: "bridge",
      },
      rootDir: nextCaseRoot("no-memory-core-vault"),
    });

    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ default: true, id: "main", workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ appConfig, config });

    expect(result).toMatchObject({
      artifactCount: 0,
      importedCount: 0,
      pagePaths: [],
      removedCount: 0,
      skippedCount: 0,
      updatedCount: 0,
      workspaces: 0,
    });
  });

  it("imports the public memory event journal when followMemoryEvents is enabled", async () => {
    const workspaceDir = await createBridgeWorkspace("events-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      config: {
        bridge: {
          enabled: true,
          followMemoryEvents: true,
        },
        vaultMode: "bridge",
      },
      rootDir: nextCaseRoot("events-vault"),
    });

    await appendMemoryHostEvent(workspaceDir, {
      query: "bridge events",
      resultCount: 1,
      results: [
        {
          endLine: 2,
          path: "memory/2026-04-05.md",
          score: 0.8,
          startLine: 1,
        },
      ],
      timestamp: "2026-04-05T12:00:00.000Z",
      type: "memory.recall.recorded",
    });
    registerBridgeArtifacts([
      {
        absolutePath: resolveMemoryHostEventLogPath(workspaceDir),
        agentIds: ["main"],
        contentType: "json",
        kind: "event-log",
        relativePath: "memory/.dreams/events.jsonl",
        workspaceDir,
      },
    ]);

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ default: true, id: "main", workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ appConfig, config });

    expect(result.artifactCount).toBe(1);
    expect(result.importedCount).toBe(1);
    expect(result.removedCount).toBe(0);
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: memory-bridge-events");
    expect(page).toContain('"type":"memory.recall.recorded"');
  });

  it("prunes stale bridge pages when the source artifact disappears", async () => {
    const workspaceDir = await createBridgeWorkspace("prune-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      config: {
        bridge: {
          enabled: true,
          followMemoryEvents: false,
          indexDailyNotes: false,
          indexDreamReports: false,
          indexMemoryRoot: true,
        },
        vaultMode: "bridge",
      },
      rootDir: nextCaseRoot("prune-vault"),
    });

    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        absolutePath: path.join(workspaceDir, "MEMORY.md"),
        agentIds: ["main"],
        contentType: "markdown",
        kind: "memory-root",
        relativePath: "MEMORY.md",
        workspaceDir,
      },
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ default: true, id: "main", workspace: workspaceDir }],
      },
    };

    const first = await syncMemoryWikiBridgeSources({ appConfig, config });
    const firstPagePath = first.pagePaths[0] ?? "";
    await expect(fs.stat(path.join(vaultDir, firstPagePath))).resolves.toBeTruthy();

    await fs.rm(path.join(workspaceDir, "MEMORY.md"));
    registerBridgeArtifacts([]);
    const second = await syncMemoryWikiBridgeSources({ appConfig, config });

    expect(second.artifactCount).toBe(0);
    expect(second.removedCount).toBe(1);
    await expect(fs.stat(path.join(vaultDir, firstPagePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
