import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import { type ArchiveLogger, extractArchive, fileExists, resolvePackedRootDir } from "./archive.js";
import { withTempDir } from "./install-source-utils.js";

export type ExistingInstallPathResult =
  | {
      ok: true;
      resolvedPath: string;
      stat: Stats;
    }
  | {
      ok: false;
      error: string;
    };

export async function resolveExistingInstallPath(
  inputPath: string,
): Promise<ExistingInstallPathResult> {
  const resolvedPath = resolveUserPath(inputPath);
  if (!(await fileExists(resolvedPath))) {
    return { error: `path not found: ${resolvedPath}`, ok: false };
  }
  const stat = await fs.stat(resolvedPath);
  return { ok: true, resolvedPath, stat };
}

export async function withExtractedArchiveRoot<TResult extends { ok: boolean }>(params: {
  archivePath: string;
  tempDirPrefix: string;
  timeoutMs: number;
  logger?: ArchiveLogger;
  rootMarkers?: string[];
  onExtracted: (rootDir: string) => Promise<TResult>;
}): Promise<TResult | { ok: false; error: string }> {
  return await withTempDir(params.tempDirPrefix, async (tmpDir) => {
    const extractDir = path.join(tmpDir, "extract");
    await fs.mkdir(extractDir, { recursive: true });

    params.logger?.info?.(`Extracting ${params.archivePath}…`);
    try {
      await extractArchive({
        archivePath: params.archivePath,
        destDir: extractDir,
        logger: params.logger,
        timeoutMs: params.timeoutMs,
      });
    } catch (error) {
      return { error: `failed to extract archive: ${String(error)}`, ok: false };
    }

    let rootDir = "";
    try {
      rootDir = await resolvePackedRootDir(extractDir, {
        rootMarkers: params.rootMarkers,
      });
    } catch (error) {
      return { error: String(error), ok: false };
    }
    return await params.onExtracted(rootDir);
  });
}
