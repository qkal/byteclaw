import fs from "node:fs/promises";
import path from "node:path";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { resolveSafeInstallDir, unscopedPackageName } from "../infra/install-safe-path.js";
import type { NpmIntegrityDrift, NpmSpecResolution } from "../infra/install-source-utils.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { parseFrontmatter } from "./frontmatter.js";

let hookInstallRuntimePromise: Promise<typeof import("./install.runtime.js")> | undefined;

async function loadHookInstallRuntime() {
  hookInstallRuntimePromise ??= import("./install.runtime.js");
  return hookInstallRuntimePromise;
}

export interface HookInstallLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

type HookPackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
} & Partial<Record<typeof MANIFEST_KEY, { hooks?: string[] }>>;

export type InstallHooksResult =
  | {
      ok: true;
      hookPackId: string;
      hooks: string[];
      targetDir: string;
      version?: string;
      npmResolution?: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    }
  | { ok: false; error: string };

export interface HookNpmIntegrityDriftParams {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
}

const defaultLogger: HookInstallLogger = {};

type HookInstallForwardParams = InstallSafetyOverrides & {
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
};

type HookPackageInstallParams = { packageDir: string } & HookInstallForwardParams;
type HookArchiveInstallParams = { archivePath: string } & HookInstallForwardParams;
type HookPathInstallParams = { path: string } & HookInstallForwardParams;

function buildHookInstallForwardParams(params: HookInstallForwardParams): HookInstallForwardParams {
  return {
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    dryRun: params.dryRun,
    expectedHookPackId: params.expectedHookPackId,
    hooksDir: params.hooksDir,
    logger: params.logger,
    mode: params.mode,
    timeoutMs: params.timeoutMs,
  };
}

function validateHookId(hookId: string): string | null {
  if (!hookId) {
    return "invalid hook name: missing";
  }
  if (hookId === "." || hookId === "..") {
    return "invalid hook name: reserved path segment";
  }
  if (hookId.includes("/") || hookId.includes("\\")) {
    return "invalid hook name: path separators not allowed";
  }
  return null;
}

export function resolveHookInstallDir(hookId: string, hooksDir?: string): string {
  const hooksBase = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
  const hookIdError = validateHookId(hookId);
  if (hookIdError) {
    throw new Error(hookIdError);
  }
  const targetDirResult = resolveSafeInstallDir({
    baseDir: hooksBase,
    id: hookId,
    invalidNameMessage: "invalid hook name: path traversal detected",
  });
  if (!targetDirResult.ok) {
    throw new Error(targetDirResult.error);
  }
  return targetDirResult.path;
}

async function ensureOpenClawHooks(manifest: HookPackageManifest) {
  const hooks = manifest[MANIFEST_KEY]?.hooks;
  if (!Array.isArray(hooks)) {
    throw new Error("package.json missing openclaw.hooks");
  }
  const list = hooks.map((e) => (typeof e === "string" ? e.trim() : "")).filter(Boolean);
  if (list.length === 0) {
    throw new Error("package.json openclaw.hooks is empty");
  }
  return list;
}

async function resolveInstallTargetDir(
  id: string,
  hooksDir?: string,
): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  const runtime = await loadHookInstallRuntime();
  const baseHooksDir = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
  return await runtime.resolveCanonicalInstallTarget({
    baseDir: baseHooksDir,
    boundaryLabel: "hooks directory",
    id,
    invalidNameMessage: "invalid hook name: path traversal detected",
  });
}

async function resolveAvailableHookInstallTarget(params: {
  id: string;
  hooksDir?: string;
  mode: "install" | "update";
  alreadyExistsError: (targetDir: string) => string;
}): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  const runtime = await loadHookInstallRuntime();
  const targetDirResult = await resolveInstallTargetDir(params.id, params.hooksDir);
  if (!targetDirResult.ok) {
    return targetDirResult;
  }
  const {targetDir} = targetDirResult;
  const availability = await runtime.ensureInstallTargetAvailable({
    alreadyExistsError: params.alreadyExistsError(targetDir),
    mode: params.mode,
    targetDir,
  });
  if (!availability.ok) {
    return availability;
  }
  return { ok: true, targetDir };
}

async function installFromResolvedHookDir(
  resolvedDir: string,
  params: HookInstallForwardParams,
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const manifestPath = path.join(resolvedDir, "package.json");
  if (await runtime.fileExists(manifestPath)) {
    return await installHookPackageFromDir({
      dryRun: params.dryRun,
      expectedHookPackId: params.expectedHookPackId,
      hooksDir: params.hooksDir,
      logger: params.logger,
      mode: params.mode,
      packageDir: resolvedDir,
      timeoutMs: params.timeoutMs,
    });
  }
  return await installHookFromDir({
    dryRun: params.dryRun,
    expectedHookPackId: params.expectedHookPackId,
    hookDir: resolvedDir,
    hooksDir: params.hooksDir,
    logger: params.logger,
    mode: params.mode,
  });
}

async function resolveHookNameFromDir(hookDir: string): Promise<string> {
  const runtime = await loadHookInstallRuntime();
  const hookMdPath = path.join(hookDir, "HOOK.md");
  if (!(await runtime.fileExists(hookMdPath))) {
    throw new Error(`HOOK.md missing in ${hookDir}`);
  }
  const raw = await fs.readFile(hookMdPath, "utf8");
  const frontmatter = parseFrontmatter(raw);
  return frontmatter.name || path.basename(hookDir);
}

async function validateHookDir(hookDir: string): Promise<void> {
  const runtime = await loadHookInstallRuntime();
  const hookMdPath = path.join(hookDir, "HOOK.md");
  if (!(await runtime.fileExists(hookMdPath))) {
    throw new Error(`HOOK.md missing in ${hookDir}`);
  }

  const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
  const hasHandler = await Promise.all(
    handlerCandidates.map(async (candidate) => runtime.fileExists(path.join(hookDir, candidate))),
  ).then((results) => results.some(Boolean));

  if (!hasHandler) {
    throw new Error(`handler.ts/handler.js/index.ts/index.js missing in ${hookDir}`);
  }
}

async function installHookPackageFromDir(
  params: HookPackageInstallParams,
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );

  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await runtime.fileExists(manifestPath))) {
    return { error: "package.json missing", ok: false };
  }

  let manifest: HookPackageManifest;
  try {
    manifest = await runtime.readJsonFile<HookPackageManifest>(manifestPath);
  } catch (error) {
    return { error: `invalid package.json: ${String(error)}`, ok: false };
  }

  let hookEntries: string[];
  try {
    hookEntries = await ensureOpenClawHooks(manifest);
  } catch (error) {
    return { error: String(error), ok: false };
  }

  const pkgName = typeof manifest.name === "string" ? manifest.name : "";
  const hookPackId = pkgName ? unscopedPackageName(pkgName) : path.basename(params.packageDir);
  const hookIdError = validateHookId(hookPackId);
  if (hookIdError) {
    return { error: hookIdError, ok: false };
  }
  if (params.expectedHookPackId && params.expectedHookPackId !== hookPackId) {
    return {
      error: `hook pack id mismatch: expected ${params.expectedHookPackId}, got ${hookPackId}`,
      ok: false,
    };
  }

  const target = await resolveAvailableHookInstallTarget({
    alreadyExistsError: (targetDir) => `hook pack already exists: ${targetDir} (delete it first)`,
    hooksDir: params.hooksDir,
    id: hookPackId,
    mode,
  });
  if (!target.ok) {
    return target;
  }
  const {targetDir} = target;

  const resolvedHooks = [] as string[];
  for (const entry of hookEntries) {
    const hookDir = path.resolve(params.packageDir, entry);
    if (!runtime.isPathInside(params.packageDir, hookDir)) {
      return {
        error: `openclaw.hooks entry escapes package directory: ${entry}`,
        ok: false,
      };
    }
    await validateHookDir(hookDir);
    if (
      !runtime.isPathInsideWithRealpath(params.packageDir, hookDir, {
        requireRealpath: true,
      })
    ) {
      return {
        error: `openclaw.hooks entry resolves outside package directory: ${entry}`,
        ok: false,
      };
    }
    const hookName = await resolveHookNameFromDir(hookDir);
    resolvedHooks.push(hookName);
  }

  if (dryRun) {
    return {
      hookPackId,
      hooks: resolvedHooks,
      ok: true,
      targetDir,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
    };
  }

  const installRes = await runtime.installPackageDirWithManifestDeps({
    copyErrorPrefix: "failed to copy hook pack",
    depsLogMessage: "Installing hook pack dependencies…",
    logger,
    manifestDependencies: manifest.dependencies,
    mode,
    sourceDir: params.packageDir,
    targetDir,
    timeoutMs,
  });
  if (!installRes.ok) {
    return installRes;
  }

  return {
    hookPackId,
    hooks: resolvedHooks,
    ok: true,
    targetDir,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
  };
}

async function installHookFromDir(params: {
  hookDir: string;
  hooksDir?: string;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
}): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const { logger, mode, dryRun } = runtime.resolveInstallModeOptions(params, defaultLogger);

  await validateHookDir(params.hookDir);
  const hookName = await resolveHookNameFromDir(params.hookDir);
  const hookIdError = validateHookId(hookName);
  if (hookIdError) {
    return { error: hookIdError, ok: false };
  }

  if (params.expectedHookPackId && params.expectedHookPackId !== hookName) {
    return {
      error: `hook id mismatch: expected ${params.expectedHookPackId}, got ${hookName}`,
      ok: false,
    };
  }

  const target = await resolveAvailableHookInstallTarget({
    alreadyExistsError: (targetDir) => `hook already exists: ${targetDir} (delete it first)`,
    hooksDir: params.hooksDir,
    id: hookName,
    mode,
  });
  if (!target.ok) {
    return target;
  }
  const {targetDir} = target;

  if (dryRun) {
    return { hookPackId: hookName, hooks: [hookName], ok: true, targetDir };
  }

  const installRes = await runtime.installPackageDir({
    copyErrorPrefix: "failed to copy hook",
    depsLogMessage: "Installing hook dependencies…",
    hasDeps: false,
    logger,
    mode,
    sourceDir: params.hookDir,
    targetDir,
    timeoutMs: 120_000,
  });
  if (!installRes.ok) {
    return installRes;
  }

  return { hookPackId: hookName, hooks: [hookName], ok: true, targetDir };
}

export async function installHooksFromArchive(
  params: HookArchiveInstallParams,
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const archivePathResult = await runtime.resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;

  return await runtime.withExtractedArchiveRoot({
    archivePath,
    logger,
    onExtracted: async (rootDir) =>
      await installFromResolvedHookDir(
        rootDir,
        buildHookInstallForwardParams({
          dryRun: params.dryRun,
          expectedHookPackId: params.expectedHookPackId,
          hooksDir: params.hooksDir,
          logger,
          mode: params.mode,
          timeoutMs,
        }),
      ),
    tempDirPrefix: "openclaw-hook-",
    timeoutMs,
  });
}

export async function installHooksFromNpmSpec(params: {
  spec: string;
  dangerouslyForceUnsafeInstall?: boolean;
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
  expectedIntegrity?: string;
  onIntegrityDrift?: (params: HookNpmIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const {expectedHookPackId} = params;
  const {spec} = params;

  logger.info?.(`Downloading ${spec.trim()}…`);
  return await runtime.installFromValidatedNpmSpecArchive({
    archiveInstallParams: buildHookInstallForwardParams({
      dryRun,
      expectedHookPackId,
      hooksDir: params.hooksDir,
      logger,
      mode,
      timeoutMs,
    }),
    expectedIntegrity: params.expectedIntegrity,
    installFromArchive: installHooksFromArchive,
    onIntegrityDrift: params.onIntegrityDrift,
    spec,
    tempDirPrefix: "openclaw-hook-pack-",
    timeoutMs,
    warn: (message) => {
      logger.warn?.(message);
    },
  });
}

export async function installHooksFromPath(
  params: HookPathInstallParams,
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const pathResult = await runtime.resolveExistingInstallPath(params.path);
  if (!pathResult.ok) {
    return pathResult;
  }
  const { resolvedPath: resolved, stat } = pathResult;
  const forwardParams = buildHookInstallForwardParams({
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    dryRun: params.dryRun,
    expectedHookPackId: params.expectedHookPackId,
    hooksDir: params.hooksDir,
    logger: params.logger,
    mode: params.mode,
    timeoutMs: params.timeoutMs,
  });

  if (stat.isDirectory()) {
    return await installFromResolvedHookDir(resolved, forwardParams);
  }

  if (!runtime.resolveArchiveKind(resolved)) {
    return { error: `unsupported hook file: ${resolved}`, ok: false };
  }

  return await installHooksFromArchive({
    archivePath: resolved,
    ...forwardParams,
  });
}
