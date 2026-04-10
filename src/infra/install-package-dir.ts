import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { fileExists } from "./archive.js";
import { assertCanonicalPathWithinBase } from "./install-safe-path.js";

const INSTALL_BASE_CHANGED_ERROR_MESSAGE = "install base directory changed during install";
const INSTALL_BASE_CHANGED_ABORT_WARNING =
  "Install base directory changed during install; aborting staged publish.";
const INSTALL_BASE_CHANGED_BACKUP_WARNING =
  "Install base directory changed before backup cleanup; leaving backup in place.";
const STAGED_NPM_PROJECT_CONFIG_NAME = ".npmrc";
const STAGED_NPM_PROJECT_CONFIG_PREFIX = ".openclaw-install-hidden-npmrc-";

type HiddenProjectConfigFile = {
  hiddenDir: string;
  originalPath: string;
  hiddenPath: string;
} | null;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sanitizeManifestForNpmInstall(targetDir: string): Promise<void> {
  const manifestPath = path.join(targetDir, "package.json");
  let manifestRaw = "";
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return;
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestRaw) as unknown;
    if (!isObjectRecord(parsed)) {
      return;
    }
    manifest = parsed;
  } catch {
    return;
  }

  const { devDependencies } = manifest;
  if (!isObjectRecord(devDependencies)) {
    return;
  }

  const filteredEntries = Object.entries(devDependencies).filter(([, rawSpec]) => {
    const spec = typeof rawSpec === "string" ? rawSpec.trim() : "";
    return !spec.startsWith("workspace:");
  });
  if (filteredEntries.length === Object.keys(devDependencies).length) {
    return;
  }

  if (filteredEntries.length === 0) {
    delete manifest.devDependencies;
  } else {
    manifest.devDependencies = Object.fromEntries(filteredEntries);
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function hideProjectNpmConfigForInstall(targetDir: string): Promise<HiddenProjectConfigFile> {
  const originalPath = path.join(targetDir, STAGED_NPM_PROJECT_CONFIG_NAME);
  let hiddenDir = "";
  try {
    hiddenDir = await fs.mkdtemp(path.join(targetDir, STAGED_NPM_PROJECT_CONFIG_PREFIX));
    const hiddenPath = path.join(hiddenDir, STAGED_NPM_PROJECT_CONFIG_NAME);
    await fs.rename(originalPath, hiddenPath);
    return { hiddenDir, hiddenPath, originalPath };
  } catch (error) {
    if (hiddenDir) {
      await fs.rm(hiddenDir, { force: true, recursive: true }).catch(() => undefined);
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function restoreProjectNpmConfigAfterInstall(
  hiddenConfig: HiddenProjectConfigFile,
): Promise<void> {
  if (!hiddenConfig) {
    return;
  }
  await fs.rename(hiddenConfig.hiddenPath, hiddenConfig.originalPath);
  await fs.rm(hiddenConfig.hiddenDir, { force: true, recursive: true });
}

async function assertInstallBoundaryPaths(params: {
  installBaseDir: string;
  candidatePaths: string[];
}): Promise<void> {
  for (const candidatePath of params.candidatePaths) {
    await assertCanonicalPathWithinBase({
      baseDir: params.installBaseDir,
      boundaryLabel: "install directory",
      candidatePath,
    });
  }
}

function isRelativePathInsideBase(relativePath: string): boolean {
  return (
    Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`)
  );
}

function isInstallBaseChangedError(error: unknown): boolean {
  return error instanceof Error && error.message === INSTALL_BASE_CHANGED_ERROR_MESSAGE;
}

async function assertInstallBaseStable(params: {
  installBaseDir: string;
  expectedRealPath: string;
}): Promise<void> {
  const baseLstat = await fs.lstat(params.installBaseDir);
  if (!baseLstat.isDirectory() || baseLstat.isSymbolicLink()) {
    throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
  }
  const currentRealPath = await fs.realpath(params.installBaseDir);
  if (currentRealPath !== params.expectedRealPath) {
    throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
  }
}

async function cleanupInstallTempDir(dirPath: string | null): Promise<void> {
  if (!dirPath) {
    return;
  }
  await fs.rm(dirPath, { force: true, recursive: true }).catch(() => undefined);
}

async function resolveInstallPublishTarget(params: {
  installBaseDir: string;
  targetDir: string;
}): Promise<{ installBaseRealPath: string; canonicalTargetDir: string }> {
  const installBaseResolved = path.resolve(params.installBaseDir);
  const targetResolved = path.resolve(params.targetDir);
  const targetRelativePath = path.relative(installBaseResolved, targetResolved);
  if (!isRelativePathInsideBase(targetRelativePath)) {
    throw new Error("invalid install target path");
  }
  const installBaseRealPath = await fs.realpath(params.installBaseDir);
  return {
    canonicalTargetDir: path.join(installBaseRealPath, targetRelativePath),
    installBaseRealPath,
  };
}

export async function installPackageDir(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  copyErrorPrefix: string;
  hasDeps: boolean;
  depsLogMessage: string;
  afterCopy?: (installedDir: string) => void | Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  params.logger?.info?.(`Installing to ${params.targetDir}…`);
  const installBaseDir = path.dirname(params.targetDir);
  await fs.mkdir(installBaseDir, { recursive: true });
  await assertInstallBoundaryPaths({
    candidatePaths: [params.targetDir],
    installBaseDir,
  });
  let installBaseRealPath: string;
  let canonicalTargetDir: string;
  try {
    ({ installBaseRealPath, canonicalTargetDir } = await resolveInstallPublishTarget({
      installBaseDir,
      targetDir: params.targetDir,
    }));
  } catch (error) {
    return { error: `${params.copyErrorPrefix}: ${String(error)}`, ok: false };
  }

  let stageDir: string | null = null;
  let backupDir: string | null = null;
  const fail = async (error: string, cause?: unknown) => {
    const installBaseChanged = isInstallBaseChangedError(cause);
    if (installBaseChanged) {
      params.logger?.warn?.(INSTALL_BASE_CHANGED_ABORT_WARNING);
    } else {
      await restoreBackup();
      if (stageDir) {
        await cleanupInstallTempDir(stageDir);
        stageDir = null;
      }
    }
    return { error, ok: false as const };
  };
  const restoreBackup = async () => {
    if (!backupDir) {
      return;
    }
    await fs.rename(backupDir, canonicalTargetDir).catch(() => undefined);
    backupDir = null;
  };

  try {
    await assertInstallBoundaryPaths({
      candidatePaths: [canonicalTargetDir],
      installBaseDir: installBaseRealPath,
    });
    stageDir = await fs.mkdtemp(path.join(installBaseRealPath, ".openclaw-install-stage-"));
    await fs.cp(params.sourceDir, stageDir, { recursive: true });
  } catch (error) {
    return await fail(`${params.copyErrorPrefix}: ${String(error)}`, error);
  }

  try {
    await params.afterCopy?.(stageDir);
  } catch (error) {
    return await fail(`post-copy validation failed: ${String(error)}`, error);
  }

  if (params.hasDeps) {
    try {
      await sanitizeManifestForNpmInstall(stageDir);
      const hiddenProjectNpmConfig = await hideProjectNpmConfigForInstall(stageDir);
      params.logger?.info?.(params.depsLogMessage);
      const npmRes = await (async () => {
        try {
          return await runCommandWithTimeout(
            // Plugins install into isolated directories, so omitting peer deps can strip
            // Runtime requirements that npm would otherwise materialize for the package.
            ["npm", "install", "--omit=dev", "--silent", "--ignore-scripts"],
            {
              cwd: stageDir,
              timeoutMs: Math.max(params.timeoutMs, 300_000),
            },
          );
        } finally {
          await restoreProjectNpmConfigAfterInstall(hiddenProjectNpmConfig);
        }
      })();
      if (npmRes.code !== 0) {
        return await fail(`npm install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`);
      }
    } catch (error) {
      return await fail(`npm install failed: ${String(error)}`, error);
    }
  }

  if (params.mode === "update" && (await fileExists(canonicalTargetDir))) {
    const backupRoot = path.join(installBaseRealPath, ".openclaw-install-backups");
    backupDir = path.join(backupRoot, `${path.basename(canonicalTargetDir)}-${Date.now()}`);
    try {
      await fs.mkdir(backupRoot, { recursive: true });
      await assertInstallBoundaryPaths({
        candidatePaths: [backupDir],
        installBaseDir: installBaseRealPath,
      });
      await assertInstallBaseStable({
        expectedRealPath: installBaseRealPath,
        installBaseDir,
      });
      await fs.rename(canonicalTargetDir, backupDir);
    } catch (error) {
      return await fail(`${params.copyErrorPrefix}: ${String(error)}`, error);
    }
  }

  try {
    await assertInstallBaseStable({
      expectedRealPath: installBaseRealPath,
      installBaseDir,
    });
    await fs.rename(stageDir, canonicalTargetDir);
    stageDir = null;
  } catch (error) {
    return await fail(`${params.copyErrorPrefix}: ${String(error)}`, error);
  }

  if (backupDir) {
    try {
      await assertInstallBaseStable({
        expectedRealPath: installBaseRealPath,
        installBaseDir,
      });
    } catch (error) {
      if (isInstallBaseChangedError(error)) {
        params.logger?.warn?.(INSTALL_BASE_CHANGED_BACKUP_WARNING);
      }
      backupDir = null;
    }
  }
  if (backupDir) {
    await fs.rm(backupDir, { force: true, recursive: true }).catch(() => undefined);
  }
  if (stageDir) {
    await cleanupInstallTempDir(stageDir);
  }

  return { ok: true };
}

export async function installPackageDirWithManifestDeps(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  copyErrorPrefix: string;
  depsLogMessage: string;
  manifestDependencies?: Record<string, unknown>;
  afterCopy?: (installedDir: string) => void | Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return installPackageDir({
    ...params,
    hasDeps: Object.keys(params.manifestDependencies ?? {}).length > 0,
  });
}
