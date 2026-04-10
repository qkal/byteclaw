import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./source-path-shared.js";
import {
  type MemoryWikiImportedSourceGroup,
  setImportedSourceEntry,
  shouldSkipImportedSourceWrite,
} from "./source-sync-state.js";

type ImportedSourceState = Parameters<typeof shouldSkipImportedSourceWrite>[0]["state"];

export async function writeImportedSourcePage(params: {
  vaultRoot: string;
  syncKey: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
  pagePath: string;
  group: MemoryWikiImportedSourceGroup;
  state: ImportedSourceState;
  buildRendered: (raw: string, updatedAt: string) => string;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const pageAbsPath = path.join(params.vaultRoot, params.pagePath);
  const created = !(await pathExists(pageAbsPath));
  const updatedAt = new Date(params.sourceUpdatedAtMs).toISOString();
  const shouldSkip = await shouldSkipImportedSourceWrite({
    expectedPagePath: params.pagePath,
    expectedSourcePath: params.sourcePath,
    renderFingerprint: params.renderFingerprint,
    sourceSize: params.sourceSize,
    sourceUpdatedAtMs: params.sourceUpdatedAtMs,
    state: params.state,
    syncKey: params.syncKey,
    vaultRoot: params.vaultRoot,
  });
  if (shouldSkip) {
    return { changed: false, created, pagePath: params.pagePath };
  }

  const raw = await fs.readFile(params.sourcePath, "utf8");
  const rendered = params.buildRendered(raw, updatedAt);
  const existing = await fs.readFile(pageAbsPath, "utf8").catch(() => "");
  if (existing !== rendered) {
    await fs.writeFile(pageAbsPath, rendered, "utf8");
  }

  setImportedSourceEntry({
    entry: {
      group: params.group,
      pagePath: params.pagePath,
      renderFingerprint: params.renderFingerprint,
      sourcePath: params.sourcePath,
      sourceSize: params.sourceSize,
      sourceUpdatedAtMs: params.sourceUpdatedAtMs,
    },
    state: params.state,
    syncKey: params.syncKey,
  });
  return { changed: existing !== rendered, created, pagePath: params.pagePath };
}
