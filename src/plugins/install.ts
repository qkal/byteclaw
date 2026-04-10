import fs from "node:fs/promises";
import path from "node:path";
import {
  packageNameMatchesId,
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
  unscopedPackageName,
} from "../infra/install-safe-path.js";
import type { NpmIntegrityDrift, NpmSpecResolution } from "../infra/install-source-utils.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import type { InstallSecurityScanResult } from "./install-security-scan.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import {
  type PackageManifest as PluginPackageManifest,
  resolvePackageExtensionEntries,
} from "./manifest.js";

let pluginInstallRuntimePromise: Promise<typeof import("./install.runtime.js")> | undefined;

async function loadPluginInstallRuntime() {
  pluginInstallRuntimePromise ??= import("./install.runtime.js");
  return pluginInstallRuntimePromise;
}

interface PluginInstallLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

type PackageManifest = PluginPackageManifest & {
  dependencies?: Record<string, string>;
};

const MISSING_EXTENSIONS_ERROR =
  'package.json missing openclaw.extensions; update the plugin package to include openclaw.extensions (for example ["./dist/index.js"]). See https://docs.openclaw.ai/help/troubleshooting#plugin-install-fails-with-missing-openclaw-extensions';
const PLUGIN_ARCHIVE_ROOT_MARKERS = [
  "package.json",
  "openclaw.plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
];

export const PLUGIN_INSTALL_ERROR_CODE = {
  EMPTY_OPENCLAW_EXTENSIONS: "empty_openclaw_extensions",
  INCOMPATIBLE_HOST_VERSION: "incompatible_host_version",
  INVALID_MIN_HOST_VERSION: "invalid_min_host_version",
  INVALID_NPM_SPEC: "invalid_npm_spec",
  MISSING_OPENCLAW_EXTENSIONS: "missing_openclaw_extensions",
  NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  PLUGIN_ID_MISMATCH: "plugin_id_mismatch",
  SECURITY_SCAN_BLOCKED: "security_scan_blocked",
  SECURITY_SCAN_FAILED: "security_scan_failed",
  UNKNOWN_HOST_VERSION: "unknown_host_version",
} as const;

export type PluginInstallErrorCode =
  (typeof PLUGIN_INSTALL_ERROR_CODE)[keyof typeof PLUGIN_INSTALL_ERROR_CODE];

export type InstallPluginResult =
  | {
      ok: true;
      pluginId: string;
      targetDir: string;
      manifestName?: string;
      version?: string;
      extensions: string[];
      npmResolution?: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    }
  | { ok: false; error: string; code?: PluginInstallErrorCode };

export interface PluginNpmIntegrityDriftParams {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
}

interface PluginInstallPolicyRequest {
  kind: "plugin-dir" | "plugin-archive" | "plugin-file" | "plugin-npm";
  requestedSpecifier?: string;
}

const defaultLogger: PluginInstallLogger = {};
function safeFileName(input: string): string {
  return safeDirName(input);
}

function encodePluginInstallDirName(pluginId: string): string {
  const trimmed = pluginId.trim();
  if (!trimmed.includes("/")) {
    return safeDirName(trimmed);
  }
  // Scoped plugin ids need a reserved on-disk namespace so they cannot collide
  // With valid unscoped ids that happen to match the hashed slug.
  return `@${safePathSegmentHashed(trimmed)}`;
}

function validatePluginId(pluginId: string): string | null {
  const trimmed = pluginId.trim();
  if (!trimmed) {
    return "invalid plugin name: missing";
  }
  if (trimmed.includes("\\")) {
    return "invalid plugin name: path separators not allowed";
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment)) {
    return "invalid plugin name: malformed scope";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "invalid plugin name: reserved path segment";
  }
  if (segments.length === 1) {
    if (trimmed.startsWith("@")) {
      return "invalid plugin name: scoped ids must use @scope/name format";
    }
    return null;
  }
  if (segments.length !== 2) {
    return "invalid plugin name: path separators not allowed";
  }
  if (!segments[0]?.startsWith("@") || segments[0].length < 2) {
    return "invalid plugin name: scoped ids must use @scope/name format";
  }
  return null;
}

function matchesExpectedPluginId(params: {
  expectedPluginId?: string;
  pluginId: string;
  manifestPluginId?: string;
  npmPluginId: string;
}): boolean {
  if (!params.expectedPluginId) {
    return true;
  }
  if (params.expectedPluginId === params.pluginId) {
    return true;
  }
  // Backward compatibility: older install records keyed scoped npm packages by
  // Their unscoped package name. Preserve update-in-place for those records
  // Unless the package declares an explicit manifest id override.
  return (
    !params.manifestPluginId &&
    params.pluginId === params.npmPluginId &&
    params.expectedPluginId === unscopedPackageName(params.npmPluginId)
  );
}

function ensureOpenClawExtensions(params: { manifest: PackageManifest }):
  | {
      ok: true;
      entries: string[];
    }
  | {
      ok: false;
      error: string;
      code: PluginInstallErrorCode;
    } {
  const resolved = resolvePackageExtensionEntries(params.manifest);
  if (resolved.status === "missing") {
    return {
      code: PLUGIN_INSTALL_ERROR_CODE.MISSING_OPENCLAW_EXTENSIONS,
      error: MISSING_EXTENSIONS_ERROR,
      ok: false,
    };
  }
  if (resolved.status === "empty") {
    return {
      code: PLUGIN_INSTALL_ERROR_CODE.EMPTY_OPENCLAW_EXTENSIONS,
      error: "package.json openclaw.extensions is empty",
      ok: false,
    };
  }
  return {
    entries: resolved.entries,
    ok: true,
  };
}

function isNpmPackageNotFoundMessage(error: string): boolean {
  const normalized = error.trim();
  if (normalized.startsWith("Package not found on npm:")) {
    return true;
  }
  return /E404|404 not found|not in this registry/i.test(normalized);
}

function buildFileInstallResult(pluginId: string, targetFile: string): InstallPluginResult {
  return {
    extensions: [path.basename(targetFile)],
    manifestName: undefined,
    ok: true,
    pluginId,
    targetDir: targetFile,
    version: undefined,
  };
}

function buildDirectoryInstallResult(params: {
  pluginId: string;
  targetDir: string;
  manifestName?: string;
  version?: string;
  extensions: string[];
}): InstallPluginResult {
  return {
    extensions: params.extensions,
    manifestName: params.manifestName,
    ok: true,
    pluginId: params.pluginId,
    targetDir: params.targetDir,
    version: params.version,
  };
}

function buildBlockedInstallResult(params: {
  blocked: NonNullable<NonNullable<InstallSecurityScanResult>["blocked"]>;
}): Extract<InstallPluginResult, { ok: false }> {
  return {
    error: params.blocked.reason,
    ok: false,
    ...(params.blocked.code === "security_scan_failed"
      ? { code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED }
      : params.blocked.code === "security_scan_blocked"
        ? { code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED }
        : {}),
  };
}

type PackageInstallCommonParams = InstallSafetyOverrides & {
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
  installPolicyRequest?: PluginInstallPolicyRequest;
};

type FileInstallCommonParams = Pick<
  PackageInstallCommonParams,
  | "dangerouslyForceUnsafeInstall"
  | "extensionsDir"
  | "logger"
  | "mode"
  | "dryRun"
  | "installPolicyRequest"
>;

function pickPackageInstallCommonParams(
  params: PackageInstallCommonParams,
): PackageInstallCommonParams {
  return {
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    dryRun: params.dryRun,
    expectedPluginId: params.expectedPluginId,
    extensionsDir: params.extensionsDir,
    installPolicyRequest: params.installPolicyRequest,
    logger: params.logger,
    mode: params.mode,
    timeoutMs: params.timeoutMs,
  };
}

function pickFileInstallCommonParams(params: FileInstallCommonParams): FileInstallCommonParams {
  return {
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    dryRun: params.dryRun,
    extensionsDir: params.extensionsDir,
    installPolicyRequest: params.installPolicyRequest,
    logger: params.logger,
    mode: params.mode,
  };
}

interface PreparedInstallTarget {
  targetPath: string;
  effectiveMode: "install" | "update";
}

async function ensureInstallTargetAvailableForMode(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  targetPath: string;
  mode: "install" | "update";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return await params.runtime.ensureInstallTargetAvailable({
    alreadyExistsError: `plugin already exists: ${params.targetPath} (delete it first)`,
    mode: params.mode,
    targetDir: params.targetPath,
  });
}

async function resolvePreparedDirectoryInstallTarget(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  pluginId: string;
  extensionsDir?: string;
  requestedMode: "install" | "update";
  nameEncoder?: (pluginId: string) => string;
}): Promise<{ ok: true; target: PreparedInstallTarget } | { ok: false; error: string }> {
  const targetDirResult = await resolvePluginInstallTarget({
    extensionsDir: params.extensionsDir,
    nameEncoder: params.nameEncoder,
    pluginId: params.pluginId,
    runtime: params.runtime,
  });
  if (!targetDirResult.ok) {
    return targetDirResult;
  }
  return {
    ok: true,
    target: {
      effectiveMode: await resolveEffectiveInstallMode({
        requestedMode: params.requestedMode,
        runtime: params.runtime,
        targetPath: targetDirResult.targetDir,
      }),
      targetPath: targetDirResult.targetDir,
    },
  };
}

async function runInstallSourceScan(params: {
  subject: string;
  scan: () => Promise<InstallSecurityScanResult | undefined>;
}): Promise<Extract<InstallPluginResult, { ok: false }> | null> {
  try {
    const scanResult = await params.scan();
    if (scanResult?.blocked) {
      return buildBlockedInstallResult({ blocked: scanResult.blocked });
    }
    return null;
  } catch (error) {
    return {
      code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED,
      error: `${params.subject} installation blocked: code safety scan failed (${String(error)}). Run "openclaw security audit --deep" for details.`,
      ok: false,
    };
  }
}

async function installPluginDirectoryIntoExtensions(params: {
  sourceDir: string;
  pluginId: string;
  manifestName?: string;
  version?: string;
  extensions: string[];
  targetDir?: string;
  extensionsDir?: string;
  logger: PluginInstallLogger;
  timeoutMs: number;
  mode: "install" | "update";
  dryRun: boolean;
  copyErrorPrefix: string;
  hasDeps: boolean;
  depsLogMessage: string;
  afterCopy?: (installedDir: string) => Promise<void>;
  nameEncoder?: (pluginId: string) => string;
}): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  let { targetDir } = params;
  if (!targetDir) {
    const targetDirResult = await resolvePluginInstallTarget({
      extensionsDir: params.extensionsDir,
      nameEncoder: params.nameEncoder,
      pluginId: params.pluginId,
      runtime,
    });
    if (!targetDirResult.ok) {
      return { error: targetDirResult.error, ok: false };
    }
    ({ targetDir } = targetDirResult);
  }
  const availability = await ensureInstallTargetAvailableForMode({
    mode: params.mode,
    runtime,
    targetPath: targetDir,
  });
  if (!availability.ok) {
    return availability;
  }

  if (params.dryRun) {
    return buildDirectoryInstallResult({
      extensions: params.extensions,
      manifestName: params.manifestName,
      pluginId: params.pluginId,
      targetDir,
      version: params.version,
    });
  }

  const installRes = await runtime.installPackageDir({
    afterCopy: params.afterCopy,
    copyErrorPrefix: params.copyErrorPrefix,
    depsLogMessage: params.depsLogMessage,
    hasDeps: params.hasDeps,
    logger: params.logger,
    mode: params.mode,
    sourceDir: params.sourceDir,
    targetDir,
    timeoutMs: params.timeoutMs,
  });
  if (!installRes.ok) {
    return installRes;
  }

  return buildDirectoryInstallResult({
    extensions: params.extensions,
    manifestName: params.manifestName,
    pluginId: params.pluginId,
    targetDir,
    version: params.version,
  });
}

export function resolvePluginInstallDir(pluginId: string, extensionsDir?: string): string {
  const extensionsBase = extensionsDir
    ? resolveUserPath(extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    throw new Error(pluginIdError);
  }
  const targetDirResult = resolveSafeInstallDir({
    baseDir: extensionsBase,
    id: pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
    nameEncoder: encodePluginInstallDirName,
  });
  if (!targetDirResult.ok) {
    throw new Error(targetDirResult.error);
  }
  return targetDirResult.path;
}

async function resolvePluginInstallTarget(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  pluginId: string;
  extensionsDir?: string;
  nameEncoder?: (pluginId: string) => string;
}): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  return await params.runtime.resolveCanonicalInstallTarget({
    baseDir: extensionsDir,
    boundaryLabel: "extensions directory",
    id: params.pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
    nameEncoder: params.nameEncoder,
  });
}

async function resolveEffectiveInstallMode(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  requestedMode: "install" | "update";
  targetPath: string;
}): Promise<"install" | "update"> {
  if (params.requestedMode !== "update") {
    return "install";
  }
  return (await params.runtime.fileExists(params.targetPath)) ? "update" : "install";
}

async function installBundleFromSourceDir(
  params: {
    sourceDir: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult | null> {
  const runtime = await loadPluginInstallRuntime();
  const bundleFormat = runtime.detectBundleManifestFormat(params.sourceDir);
  if (!bundleFormat) {
    return null;
  }

  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const manifestRes = runtime.loadBundleManifest({
    bundleFormat,
    rejectHardlinks: true,
    rootDir: params.sourceDir,
  });
  if (!manifestRes.ok) {
    return { error: manifestRes.error, ok: false };
  }

  const pluginId = manifestRes.manifest.id;
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { error: pluginIdError, ok: false };
  }
  if (params.expectedPluginId && params.expectedPluginId !== pluginId) {
    return {
      code: PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH,
      error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${pluginId}`,
      ok: false,
    };
  }

  const targetResult = await resolvePreparedDirectoryInstallTarget({
    extensionsDir: params.extensionsDir,
    pluginId,
    requestedMode: mode,
    runtime,
  });
  if (!targetResult.ok) {
    return { error: targetResult.error, ok: false };
  }

  const scanResult = await runInstallSourceScan({
    scan: async () =>
      await runtime.scanBundleInstallSource({
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        logger,
        mode: targetResult.target.effectiveMode,
        pluginId,
        requestKind: params.installPolicyRequest?.kind,
        requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
        sourceDir: params.sourceDir,
        version: manifestRes.manifest.version,
      }),
    subject: `Bundle "${pluginId}"`,
  });
  if (scanResult) {
    return scanResult;
  }

  return await installPluginDirectoryIntoExtensions({
    copyErrorPrefix: "failed to copy plugin bundle",
    depsLogMessage: "",
    dryRun,
    extensions: [],
    extensionsDir: params.extensionsDir,
    hasDeps: false,
    logger,
    manifestName: manifestRes.manifest.name,
    mode: targetResult.target.effectiveMode,
    pluginId,
    sourceDir: params.sourceDir,
    targetDir: targetResult.target.targetPath,
    timeoutMs,
    version: manifestRes.manifest.version,
  });
}

async function installPluginFromSourceDir(
  params: {
    sourceDir: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const nativePackageDetected = await detectNativePackageInstallSource(params.sourceDir);
  if (nativePackageDetected) {
    return await installPluginFromPackageDir({
      packageDir: params.sourceDir,
      ...pickPackageInstallCommonParams(params),
    });
  }
  const bundleResult = await installBundleFromSourceDir({
    sourceDir: params.sourceDir,
    ...pickPackageInstallCommonParams(params),
  });
  if (bundleResult) {
    return bundleResult;
  }
  return await installPluginFromPackageDir({
    packageDir: params.sourceDir,
    ...pickPackageInstallCommonParams(params),
  });
}

async function detectNativePackageInstallSource(packageDir: string): Promise<boolean> {
  const runtime = await loadPluginInstallRuntime();
  const manifestPath = path.join(packageDir, "package.json");
  if (!(await runtime.fileExists(manifestPath))) {
    return false;
  }

  try {
    const manifest = await runtime.readJsonFile<PackageManifest>(manifestPath);
    return ensureOpenClawExtensions({ manifest }).ok;
  } catch {
    return false;
  }
}

async function installPluginFromPackageDir(
  params: {
    packageDir: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );

  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await runtime.fileExists(manifestPath))) {
    return { error: "extracted package missing package.json", ok: false };
  }

  let manifest: PackageManifest;
  try {
    manifest = await runtime.readJsonFile<PackageManifest>(manifestPath);
  } catch (error) {
    return { error: `invalid package.json: ${String(error)}`, ok: false };
  }

  const extensionsResult = ensureOpenClawExtensions({
    manifest,
  });
  if (!extensionsResult.ok) {
    return {
      code: extensionsResult.code,
      error: extensionsResult.error,
      ok: false,
    };
  }
  const extensions = extensionsResult.entries;

  const pkgName = normalizeOptionalString(manifest.name) ?? "";
  const npmPluginId = pkgName || "plugin";

  // Prefer the canonical `id` from openclaw.plugin.json over the npm package name.
  // This avoids a latent key-mismatch bug: if the manifest id (e.g. "memory-cognee")
  // Differs from the npm package name (e.g. "cognee-openclaw"), the plugin registry
  // Uses the manifest id as the authoritative key, so the config entry must match it.
  const ocManifestResult = runtime.loadPluginManifest(params.packageDir);
  const manifestPluginId =
    ocManifestResult.ok && ocManifestResult.manifest.id
      ? ocManifestResult.manifest.id.trim()
      : undefined;

  const pluginId = manifestPluginId ?? npmPluginId;
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { error: pluginIdError, ok: false };
  }
  if (
    !matchesExpectedPluginId({
      expectedPluginId: params.expectedPluginId,
      manifestPluginId,
      npmPluginId,
      pluginId,
    })
  ) {
    return {
      code: PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH,
      error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${pluginId}`,
      ok: false,
    };
  }

  if (manifestPluginId && !packageNameMatchesId(npmPluginId, manifestPluginId)) {
    logger.info?.(
      `Plugin manifest id "${manifestPluginId}" differs from npm package name "${npmPluginId}"; using manifest id as the config key.`,
    );
  }

  const packageMetadata = runtime.getPackageManifestMetadata(manifest);
  const minHostVersionCheck = runtime.checkMinHostVersion({
    currentVersion: runtime.resolveCompatibilityHostVersion(),
    minHostVersion: packageMetadata?.install?.minHostVersion,
  });
  if (!minHostVersionCheck.ok) {
    if (minHostVersionCheck.kind === "invalid") {
      return {
        code: PLUGIN_INSTALL_ERROR_CODE.INVALID_MIN_HOST_VERSION,
        error: `invalid package.json openclaw.install.minHostVersion: ${minHostVersionCheck.error}`,
        ok: false,
      };
    }
    if (minHostVersionCheck.kind === "unknown_host_version") {
      return {
        code: PLUGIN_INSTALL_ERROR_CODE.UNKNOWN_HOST_VERSION,
        error: `plugin "${pluginId}" requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined. Re-run from a released build or set OPENCLAW_VERSION and retry.`,
        ok: false,
      };
    }
    return {
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_HOST_VERSION,
      error: `plugin "${pluginId}" requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}. Upgrade OpenClaw and retry.`,
      ok: false,
    };
  }

  const targetResult = await resolvePreparedDirectoryInstallTarget({
    extensionsDir: params.extensionsDir,
    nameEncoder: encodePluginInstallDirName,
    pluginId,
    requestedMode: mode,
    runtime,
  });
  if (!targetResult.ok) {
    return { error: targetResult.error, ok: false };
  }

  const scanResult = await runInstallSourceScan({
    scan: async () =>
      await runtime.scanPackageInstallSource({
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        extensions,
        logger,
        manifestId: manifestPluginId,
        mode: targetResult.target.effectiveMode,
        packageDir: params.packageDir,
        packageName: pkgName || undefined,
        pluginId,
        requestKind: params.installPolicyRequest?.kind,
        requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
        version: typeof manifest.version === "string" ? manifest.version : undefined,
      }),
    subject: `Plugin "${pluginId}"`,
  });
  if (scanResult) {
    return scanResult;
  }

  const deps = manifest.dependencies ?? {};
  return await installPluginDirectoryIntoExtensions({
    afterCopy: async (installedDir) => {
      for (const entry of extensions) {
        const resolvedEntry = path.resolve(installedDir, entry);
        if (!runtime.isPathInside(installedDir, resolvedEntry)) {
          logger.warn?.(`extension entry escapes plugin directory: ${entry}`);
          continue;
        }
        if (!(await runtime.fileExists(resolvedEntry))) {
          logger.warn?.(`extension entry not found: ${entry}`);
        }
      }
    },
    copyErrorPrefix: "failed to copy plugin",
    depsLogMessage: "Installing plugin dependencies…",
    dryRun,
    extensions,
    extensionsDir: params.extensionsDir,
    hasDeps: Object.keys(deps).length > 0,
    logger,
    manifestName: pkgName || undefined,
    mode: targetResult.target.effectiveMode,
    nameEncoder: encodePluginInstallDirName,
    pluginId,
    sourceDir: params.packageDir,
    targetDir: targetResult.target.targetPath,
    timeoutMs,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
  });
}

export async function installPluginFromArchive(
  params: {
    archivePath: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const mode = params.mode ?? "install";
  const installPolicyRequest = params.installPolicyRequest ?? {
    kind: "plugin-archive",
    requestedSpecifier: params.archivePath,
  };
  const archivePathResult = await runtime.resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;

  return await runtime.withExtractedArchiveRoot({
    archivePath,
    logger,
    onExtracted: async (sourceDir) =>
      await installPluginFromSourceDir({
        sourceDir,
        ...pickPackageInstallCommonParams({
          dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
          dryRun: params.dryRun,
          expectedPluginId: params.expectedPluginId,
          extensionsDir: params.extensionsDir,
          installPolicyRequest,
          logger,
          mode,
          timeoutMs,
        }),
      }),
    rootMarkers: PLUGIN_ARCHIVE_ROOT_MARKERS,
    tempDirPrefix: "openclaw-plugin-",
    timeoutMs,
  });
}

export async function installPluginFromDir(
  params: {
    dirPath: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const dirPath = resolveUserPath(params.dirPath);
  const installPolicyRequest = params.installPolicyRequest ?? {
    kind: "plugin-dir",
    requestedSpecifier: params.dirPath,
  };
  if (!(await runtime.fileExists(dirPath))) {
    return { error: `directory not found: ${dirPath}`, ok: false };
  }
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return { error: `not a directory: ${dirPath}`, ok: false };
  }

  return await installPluginFromSourceDir({
    sourceDir: dirPath,
    ...pickPackageInstallCommonParams({
      ...params,
      installPolicyRequest,
    }),
  });
}

export async function installPluginFromFile(params: {
  filePath: string;
  dangerouslyForceUnsafeInstall?: boolean;
  extensionsDir?: string;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  installPolicyRequest?: PluginInstallPolicyRequest;
}): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, mode, dryRun } = runtime.resolveInstallModeOptions(params, defaultLogger);

  const filePath = resolveUserPath(params.filePath);
  const installPolicyRequest = params.installPolicyRequest ?? {
    kind: "plugin-file",
    requestedSpecifier: params.filePath,
  };
  if (!(await runtime.fileExists(filePath))) {
    return { error: `file not found: ${filePath}`, ok: false };
  }

  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  await fs.mkdir(extensionsDir, { recursive: true });

  const base = path.basename(filePath, path.extname(filePath));
  const pluginId = base || "plugin";
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { error: pluginIdError, ok: false };
  }
  const targetFile = path.join(extensionsDir, `${safeFileName(pluginId)}${path.extname(filePath)}`);
  const preparedTarget: PreparedInstallTarget = {
    effectiveMode: await resolveEffectiveInstallMode({
      requestedMode: mode,
      runtime,
      targetPath: targetFile,
    }),
    targetPath: targetFile,
  };

  const availability = await ensureInstallTargetAvailableForMode({
    mode: preparedTarget.effectiveMode,
    runtime,
    targetPath: preparedTarget.targetPath,
  });
  if (!availability.ok) {
    return availability;
  }

  if (dryRun) {
    return buildFileInstallResult(pluginId, preparedTarget.targetPath);
  }

  const scanResult = await runInstallSourceScan({
    scan: async () =>
      await runtime.scanFileInstallSource({
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        filePath,
        logger,
        mode: preparedTarget.effectiveMode,
        pluginId,
        requestedSpecifier: installPolicyRequest.requestedSpecifier,
      }),
    subject: `Plugin file "${pluginId}"`,
  });
  if (scanResult) {
    return scanResult;
  }

  logger.info?.(`Installing to ${preparedTarget.targetPath}…`);
  try {
    await runtime.writeFileFromPathWithinRoot({
      relativePath: path.basename(preparedTarget.targetPath),
      rootDir: extensionsDir,
      sourcePath: filePath,
    });
  } catch (error) {
    return { error: String(error), ok: false };
  }

  return buildFileInstallResult(pluginId, preparedTarget.targetPath);
}

export async function installPluginFromNpmSpec(
  params: InstallSafetyOverrides & {
    spec: string;
    extensionsDir?: string;
    timeoutMs?: number;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    expectedIntegrity?: string;
    onIntegrityDrift?: (params: PluginNpmIntegrityDriftParams) => boolean | Promise<boolean>;
  },
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const { expectedPluginId } = params;
  const spec = params.spec.trim();
  const specError = runtime.validateRegistryNpmSpec(spec);
  if (specError) {
    return {
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
      error: specError,
      ok: false,
    };
  }

  logger.info?.(`Downloading ${spec}…`);
  const installPolicyRequest: PluginInstallPolicyRequest = {
    kind: "plugin-npm",
    requestedSpecifier: spec,
  };
  const flowResult = await runtime.installFromNpmSpecArchiveWithInstaller({
    archiveInstallParams: {
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      dryRun,
      expectedPluginId,
      extensionsDir: params.extensionsDir,
      installPolicyRequest,
      logger,
      mode,
      timeoutMs,
    },
    expectedIntegrity: params.expectedIntegrity,
    installFromArchive: installPluginFromArchive,
    onIntegrityDrift: params.onIntegrityDrift,
    spec,
    tempDirPrefix: "openclaw-npm-pack-",
    timeoutMs,
    warn: (message) => {
      logger.warn?.(message);
    },
  });
  const finalized = runtime.finalizeNpmSpecArchiveInstall(flowResult);
  if (!finalized.ok && isNpmPackageNotFoundMessage(finalized.error)) {
    return {
      code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
      error: finalized.error,
      ok: false,
    };
  }
  return finalized;
}

export async function installPluginFromPath(
  params: {
    path: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const pathResult = await runtime.resolveExistingInstallPath(params.path);
  if (!pathResult.ok) {
    return pathResult;
  }
  const { resolvedPath: resolved, stat } = pathResult;
  const packageInstallOptions = pickPackageInstallCommonParams(params);

  if (stat.isDirectory()) {
    return await installPluginFromDir({
      dirPath: resolved,
      ...packageInstallOptions,
      installPolicyRequest: {
        kind: "plugin-dir",
        requestedSpecifier: params.path,
      },
    });
  }

  const archiveKind = runtime.resolveArchiveKind(resolved);
  if (archiveKind) {
    return await installPluginFromArchive({
      archivePath: resolved,
      ...packageInstallOptions,
      installPolicyRequest: {
        kind: "plugin-archive",
        requestedSpecifier: params.path,
      },
    });
  }

  return await installPluginFromFile({
    filePath: resolved,
    ...pickFileInstallCommonParams({
      ...params,
      installPolicyRequest: {
        kind: "plugin-file",
        requestedSpecifier: params.path,
      },
    }),
  });
}
