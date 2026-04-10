import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { BridgeMemoryWikiResult } from "./bridge.js";
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

interface UnsafeLocalArtifact {
  syncKey: string;
  configuredPath: string;
  absolutePath: string;
  relativePath: string;
}

const DIRECTORY_TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".yaml", ".yml"]);

function detectFenceLanguage(filePath: string): string {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  if (ext === ".json" || ext === ".jsonl") {
    return "json";
  }
  if (ext === ".yaml" || ext === ".yml") {
    return "yaml";
  }
  if (ext === ".txt") {
    return "text";
  }
  return "markdown";
}

async function listAllowedFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listAllowedFilesRecursive(fullPath)));
      continue;
    }
    if (
      entry.isFile() &&
      DIRECTORY_TEXT_EXTENSIONS.has(normalizeLowercaseStringOrEmpty(path.extname(entry.name)))
    ) {
      files.push(fullPath);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

async function collectUnsafeLocalArtifacts(
  configuredPaths: string[],
): Promise<UnsafeLocalArtifact[]> {
  const artifacts: UnsafeLocalArtifact[] = [];
  for (const configuredPath of configuredPaths) {
    const absoluteConfiguredPath = path.resolve(configuredPath);
    const stat = await fs.stat(absoluteConfiguredPath).catch(() => null);
    if (!stat) {
      continue;
    }
    if (stat.isDirectory()) {
      const files = await listAllowedFilesRecursive(absoluteConfiguredPath);
      for (const absolutePath of files) {
        artifacts.push({
          absolutePath,
          configuredPath: absoluteConfiguredPath,
          relativePath: path.relative(absoluteConfiguredPath, absolutePath).replace(/\\/g, "/"),
          syncKey: await resolveArtifactKey(absolutePath),
        });
      }
      continue;
    }
    if (stat.isFile()) {
      artifacts.push({
        absolutePath: absoluteConfiguredPath,
        configuredPath: absoluteConfiguredPath,
        relativePath: path.basename(absoluteConfiguredPath),
        syncKey: await resolveArtifactKey(absoluteConfiguredPath),
      });
    }
  }

  const deduped = new Map<string, UnsafeLocalArtifact>();
  for (const artifact of artifacts) {
    deduped.set(artifact.syncKey, artifact);
  }
  return [...deduped.values()];
}

function resolveUnsafeLocalPagePath(params: { configuredPath: string; absolutePath: string }): {
  pageId: string;
  pagePath: string;
} {
  const configuredBaseSlug = slugifyWikiSegment(path.basename(params.configuredPath));
  const configuredHash = createHash("sha1")
    .update(path.resolve(params.configuredPath))
    .digest("hex")
    .slice(0, 8);
  const artifactBaseSlug = slugifyWikiSegment(path.basename(params.absolutePath));
  const artifactHash = createHash("sha1")
    .update(path.resolve(params.absolutePath))
    .digest("hex")
    .slice(0, 8);
  const pageSlug = `${configuredBaseSlug}-${configuredHash}-${artifactBaseSlug}-${artifactHash}`;
  return {
    pageId: `source.unsafe-local.${pageSlug}`,
    pagePath: path.join("sources", `unsafe-local-${pageSlug}.md`).replace(/\\/g, "/"),
  };
}

function resolveUnsafeLocalTitle(artifact: UnsafeLocalArtifact): string {
  return `Unsafe Local Import: ${artifact.relativePath}`;
}

async function writeUnsafeLocalSourcePage(params: {
  config: ResolvedMemoryWikiConfig;
  artifact: UnsafeLocalArtifact;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  state: Awaited<ReturnType<typeof readMemoryWikiSourceSyncState>>;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const { pageId, pagePath } = resolveUnsafeLocalPagePath({
    absolutePath: params.artifact.absolutePath,
    configuredPath: params.artifact.configuredPath,
  });
  const title = resolveUnsafeLocalTitle(params.artifact);
  const renderFingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        configuredPath: params.artifact.configuredPath,
        relativePath: params.artifact.relativePath,
      }),
    )
    .digest("hex");
  return writeImportedSourcePage({
    buildRendered: (raw, updatedAt) =>
      renderWikiMarkdown({
        body: [
          `# ${title}`,
          "",
          "## Unsafe Local Source",
          `- Configured path: \`${params.artifact.configuredPath}\``,
          `- Relative path: \`${params.artifact.relativePath}\``,
          `- Updated: ${updatedAt}`,
          "",
          "## Content",
          renderMarkdownFence(raw, detectFenceLanguage(params.artifact.absolutePath)),
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
          "",
        ].join("\n"),
        frontmatter: {
          id: pageId,
          pageType: "source",
          provenanceMode: "unsafe-local",
          sourcePath: params.artifact.absolutePath,
          sourceType: "memory-unsafe-local",
          status: "active",
          title,
          unsafeLocalConfiguredPath: params.artifact.configuredPath,
          unsafeLocalRelativePath: params.artifact.relativePath,
          updatedAt,
        },
      }),
    group: "unsafe-local",
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

export async function syncMemoryWikiUnsafeLocalSources(
  config: ResolvedMemoryWikiConfig,
): Promise<BridgeMemoryWikiResult> {
  await initializeMemoryWikiVault(config);
  if (
    config.vaultMode !== "unsafe-local" ||
    !config.unsafeLocal.allowPrivateMemoryCoreAccess ||
    config.unsafeLocal.paths.length === 0
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

  const artifacts = await collectUnsafeLocalArtifacts(config.unsafeLocal.paths);
  const state = await readMemoryWikiSourceSyncState(config.vault.path);
  const activeKeys = new Set<string>();
  const results = await Promise.all(
    artifacts.map(async (artifact) => {
      const stats = await fs.stat(artifact.absolutePath);
      activeKeys.add(artifact.syncKey);
      return await writeUnsafeLocalSourcePage({
        artifact,
        config,
        sourceSize: stats.size,
        sourceUpdatedAtMs: stats.mtimeMs,
        state,
      });
    }),
  );

  const removedCount = await pruneImportedSourceEntries({
    activeKeys,
    group: "unsafe-local",
    state,
    vaultRoot: config.vault.path,
  });
  await writeMemoryWikiSourceSyncState(config.vault.path, state);
  const importedCount = results.filter((result) => result.changed && result.created).length;
  const updatedCount = results.filter((result) => result.changed && !result.created).length;
  const skippedCount = results.filter((result) => !result.changed).length;
  const pagePaths = results
    .map((result) => result.pagePath)
    .toSorted((left, right) => left.localeCompare(right));

  if (importedCount > 0 || updatedCount > 0 || removedCount > 0) {
    await appendMemoryWikiLog(config.vault.path, {
      details: {
        artifactCount: artifacts.length,
        configuredPathCount: config.unsafeLocal.paths.length,
        importedCount,
        removedCount,
        skippedCount,
        sourceType: "memory-unsafe-local",
        updatedCount,
      },
      timestamp: new Date().toISOString(),
      type: "ingest",
    });
  }

  return {
    artifactCount: artifacts.length,
    importedCount,
    pagePaths,
    removedCount,
    skippedCount,
    updatedCount,
    workspaces: 0,
  };
}
