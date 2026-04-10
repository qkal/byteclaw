import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type MemoryPluginPublicArtifact,
  listActiveMemoryPublicArtifacts,
} from "openclaw/plugin-sdk/memory-host-core";
import type { OpenClawConfig } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import { renderMarkdownFence, renderWikiMarkdown, slugifyWikiSegment } from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { resolveArtifactKey } from "./source-path-shared.js";
import {
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
import { initializeMemoryWikiVault } from "./vault.js";

interface BridgeArtifact {
  syncKey: string;
  artifactType: "markdown" | "memory-events";
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
}

export interface BridgeMemoryWikiResult {
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  removedCount: number;
  artifactCount: number;
  workspaces: number;
  pagePaths: string[];
}

function shouldImportArtifact(
  artifact: MemoryPluginPublicArtifact,
  bridgeConfig: ResolvedMemoryWikiConfig["bridge"],
): boolean {
  switch (artifact.kind) {
    case "memory-root": {
      return bridgeConfig.indexMemoryRoot;
    }
    case "daily-note": {
      return bridgeConfig.indexDailyNotes;
    }
    case "dream-report": {
      return bridgeConfig.indexDreamReports;
    }
    case "event-log": {
      return bridgeConfig.followMemoryEvents;
    }
    default: {
      return false;
    }
  }
}

async function collectBridgeArtifacts(
  bridgeConfig: ResolvedMemoryWikiConfig["bridge"],
  artifacts: MemoryPluginPublicArtifact[],
): Promise<BridgeArtifact[]> {
  const collected: BridgeArtifact[] = [];
  for (const artifact of artifacts) {
    if (!shouldImportArtifact(artifact, bridgeConfig)) {
      continue;
    }
    const syncKey = await resolveArtifactKey(artifact.absolutePath);
    collected.push({
      absolutePath: artifact.absolutePath,
      artifactType: artifact.kind === "event-log" ? "memory-events" : "markdown",
      relativePath: artifact.relativePath,
      syncKey,
      workspaceDir: artifact.workspaceDir,
    });
  }
  const deduped = new Map<string, BridgeArtifact>();
  for (const artifact of collected) {
    deduped.set(artifact.syncKey, artifact);
  }
  return [...deduped.values()];
}

function resolveBridgeTitle(artifact: BridgeArtifact, agentIds: string[]): string {
  if (artifact.artifactType === "memory-events") {
    if (agentIds.length === 0) {
      return "Memory Bridge: event journal";
    }
    return `Memory Bridge (${agentIds.join(", ")}): event journal`;
  }
  const base = artifact.relativePath
    .replace(/\.md$/i, "")
    .replace(/^memory\//, "")
    .replace(/\//g, " / ");
  if (agentIds.length === 0) {
    return `Memory Bridge: ${base}`;
  }
  return `Memory Bridge (${agentIds.join(", ")}): ${base}`;
}

function resolveBridgePagePath(params: { workspaceDir: string; relativePath: string }): {
  pageId: string;
  pagePath: string;
  workspaceSlug: string;
  artifactSlug: string;
} {
  const workspaceBaseSlug = slugifyWikiSegment(path.basename(params.workspaceDir));
  const workspaceHash = createHash("sha1").update(path.resolve(params.workspaceDir)).digest("hex");
  const artifactBaseSlug = slugifyWikiSegment(
    params.relativePath.replace(/\.md$/i, "").replace(/\//g, "-"),
  );
  const artifactHash = createHash("sha1").update(params.relativePath).digest("hex");
  const workspaceSlug = `${workspaceBaseSlug}-${workspaceHash.slice(0, 8)}`;
  const artifactSlug = `${artifactBaseSlug}-${artifactHash.slice(0, 8)}`;
  return {
    artifactSlug,
    pageId: `source.bridge.${workspaceSlug}.${artifactSlug}`,
    pagePath: path
      .join("sources", `bridge-${workspaceSlug}-${artifactSlug}.md`)
      .replace(/\\/g, "/"),
    workspaceSlug,
  };
}

async function writeBridgeSourcePage(params: {
  config: ResolvedMemoryWikiConfig;
  artifact: BridgeArtifact;
  agentIds: string[];
  sourceUpdatedAtMs: number;
  sourceSize: number;
  state: Awaited<ReturnType<typeof readMemoryWikiSourceSyncState>>;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const { pageId, pagePath } = resolveBridgePagePath({
    relativePath: params.artifact.relativePath,
    workspaceDir: params.artifact.workspaceDir,
  });
  const title = resolveBridgeTitle(params.artifact, params.agentIds);
  const renderFingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        agentIds: params.agentIds,
        artifactType: params.artifact.artifactType,
        relativePath: params.artifact.relativePath,
        workspaceDir: params.artifact.workspaceDir,
      }),
    )
    .digest("hex");
  return writeImportedSourcePage({
    buildRendered: (raw, updatedAt) => {
      const contentLanguage =
        params.artifact.artifactType === "memory-events" ? "json" : "markdown";
      return renderWikiMarkdown({
        body: [
          `# ${title}`,
          "",
          "## Bridge Source",
          `- Workspace: \`${params.artifact.workspaceDir}\``,
          `- Relative path: \`${params.artifact.relativePath}\``,
          `- Kind: \`${params.artifact.artifactType}\``,
          `- Agents: ${params.agentIds.length > 0 ? params.agentIds.join(", ") : "unknown"}`,
          `- Updated: ${updatedAt}`,
          "",
          "## Content",
          renderMarkdownFence(raw, contentLanguage),
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
          "",
        ].join("\n"),
        frontmatter: {
          bridgeAgentIds: params.agentIds,
          bridgeRelativePath: params.artifact.relativePath,
          bridgeWorkspaceDir: params.artifact.workspaceDir,
          id: pageId,
          pageType: "source",
          sourcePath: params.artifact.absolutePath,
          sourceType:
            params.artifact.artifactType === "memory-events"
              ? "memory-bridge-events"
              : "memory-bridge",
          status: "active",
          title,
          updatedAt,
        },
      });
    },
    group: "bridge",
    pagePath,
    renderFingerprint,
    sourcePath: params.artifact.absolutePath,
    sourceSize: params.sourceSize,
    sourceUpdatedAtMs: params.sourceUpdatedAtMs,
    state: params.state,
    syncKey: params.artifact.syncKey,
    vaultRoot: params.config.vault.path,
  });
}

export async function syncMemoryWikiBridgeSources(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
}): Promise<BridgeMemoryWikiResult> {
  await initializeMemoryWikiVault(params.config);
  if (
    params.config.vaultMode !== "bridge" ||
    !params.config.bridge.enabled ||
    !params.config.bridge.readMemoryArtifacts ||
    !params.appConfig
  ) {
    return {
      artifactCount: 0,
      importedCount: 0,
      pagePaths: [],
      removedCount: 0,
      skippedCount: 0,
      updatedCount: 0,
      workspaces: 0,
    };
  }

  const publicArtifacts = await listActiveMemoryPublicArtifacts({ cfg: params.appConfig });
  const state = await readMemoryWikiSourceSyncState(params.config.vault.path);
  const results: { pagePath: string; changed: boolean; created: boolean }[] = [];
  let artifactCount = 0;
  const activeKeys = new Set<string>();
  const artifacts = await collectBridgeArtifacts(params.config.bridge, publicArtifacts);
  const agentIdsByWorkspace = new Map<string, string[]>();
  for (const artifact of publicArtifacts) {
    agentIdsByWorkspace.set(artifact.workspaceDir, artifact.agentIds);
  }
  artifactCount = artifacts.length;
  for (const artifact of artifacts) {
    const stats = await fs.stat(artifact.absolutePath);
    activeKeys.add(artifact.syncKey);
    results.push(
      await writeBridgeSourcePage({
        agentIds: agentIdsByWorkspace.get(artifact.workspaceDir) ?? [],
        artifact,
        config: params.config,
        sourceSize: stats.size,
        sourceUpdatedAtMs: stats.mtimeMs,
        state,
      }),
    );
  }
  const workspaceCount = new Set(publicArtifacts.map((artifact) => artifact.workspaceDir)).size;

  const removedCount = await pruneImportedSourceEntries({
    activeKeys,
    group: "bridge",
    state,
    vaultRoot: params.config.vault.path,
  });
  await writeMemoryWikiSourceSyncState(params.config.vault.path, state);
  const importedCount = results.filter((result) => result.changed && result.created).length;
  const updatedCount = results.filter((result) => result.changed && !result.created).length;
  const skippedCount = results.filter((result) => !result.changed).length;
  const pagePaths = results
    .map((result) => result.pagePath)
    .toSorted((left, right) => left.localeCompare(right));

  if (importedCount > 0 || updatedCount > 0 || removedCount > 0) {
    await appendMemoryWikiLog(params.config.vault.path, {
      details: {
        artifactCount,
        importedCount,
        removedCount,
        skippedCount,
        sourceType: "memory-bridge",
        updatedCount,
        workspaces: workspaceCount,
      },
      timestamp: new Date().toISOString(),
      type: "ingest",
    });
  }

  return {
    artifactCount,
    importedCount,
    pagePaths,
    removedCount,
    skippedCount,
    updatedCount,
    workspaces: workspaceCount,
  };
}
