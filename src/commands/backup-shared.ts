import fs from "node:fs/promises";
import path from "node:path";
import {
  readConfigFileSnapshot,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { pathExists, shortenHomePath } from "../utils.js";
import { buildCleanupPlan, isPathWithin } from "./cleanup-utils.js";

export type BackupAssetKind = "state" | "config" | "credentials" | "workspace";
export type BackupSkipReason = "covered" | "missing";

export interface BackupAsset {
  kind: BackupAssetKind;
  sourcePath: string;
  displayPath: string;
  archivePath: string;
}

export interface SkippedBackupAsset {
  kind: BackupAssetKind;
  sourcePath: string;
  displayPath: string;
  reason: BackupSkipReason;
  coveredBy?: string;
}

export interface BackupPlan {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
  included: BackupAsset[];
  skipped: SkippedBackupAsset[];
}

interface BackupAssetCandidate {
  kind: BackupAssetKind;
  sourcePath: string;
  canonicalPath: string;
  exists: boolean;
}

function backupAssetPriority(kind: BackupAssetKind): number {
  switch (kind) {
    case "state": {
      return 0;
    }
    case "config": {
      return 1;
    }
    case "credentials": {
      return 2;
    }
    case "workspace": {
      return 3;
    }
  }
}

export function buildBackupArchiveRoot(nowMs = Date.now()): string {
  return `${formatSessionArchiveTimestamp(nowMs)}-openclaw-backup`;
}

export function buildBackupArchiveBasename(nowMs = Date.now()): string {
  return `${buildBackupArchiveRoot(nowMs)}.tar.gz`;
}

export function encodeAbsolutePathForBackupArchive(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/");
  const windowsMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (windowsMatch) {
    const drive = windowsMatch[1]?.toUpperCase() ?? "UNKNOWN";
    const rest = windowsMatch[2] ?? "";
    return path.posix.join("windows", drive, rest);
  }
  if (normalized.startsWith("/")) {
    return path.posix.join("posix", normalized.slice(1));
  }
  return path.posix.join("relative", normalized);
}

export function buildBackupArchivePath(archiveRoot: string, sourcePath: string): string {
  return path.posix.join(archiveRoot, "payload", encodeAbsolutePathForBackupArchive(sourcePath));
}

export async function resolveBackupPlanFromPaths(params: {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs?: string[];
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  configInsideState?: boolean;
  oauthInsideState?: boolean;
  nowMs?: number;
}): Promise<BackupPlan> {
  const includeWorkspace = params.includeWorkspace ?? true;
  const onlyConfig = params.onlyConfig ?? false;
  const {stateDir} = params;
  const {configPath} = params;
  const {oauthDir} = params;
  const archiveRoot = buildBackupArchiveRoot(params.nowMs);
  const workspaceDirs = includeWorkspace ? (params.workspaceDirs ?? []) : [];
  const configInsideState = params.configInsideState ?? false;
  const oauthInsideState = params.oauthInsideState ?? false;

  if (onlyConfig) {
    const resolvedConfigPath = path.resolve(configPath);
    if (!(await pathExists(resolvedConfigPath))) {
      return {
        configPath,
        included: [],
        oauthDir,
        skipped: [
          {
            displayPath: shortenHomePath(resolvedConfigPath),
            kind: "config",
            reason: "missing",
            sourcePath: resolvedConfigPath,
          },
        ],
        stateDir,
        workspaceDirs: [],
      };
    }

    const canonicalConfigPath = await canonicalizeExistingPath(resolvedConfigPath);
    return {
      configPath,
      included: [
        {
          archivePath: buildBackupArchivePath(archiveRoot, canonicalConfigPath),
          displayPath: shortenHomePath(canonicalConfigPath),
          kind: "config",
          sourcePath: canonicalConfigPath,
        },
      ],
      oauthDir,
      skipped: [],
      stateDir,
      workspaceDirs: [],
    };
  }

  const rawCandidates: Pick<BackupAssetCandidate, "kind" | "sourcePath">[] = [
    { kind: "state", sourcePath: path.resolve(stateDir) },
    ...(configInsideState
      ? []
      : [{ kind: "config" as const, sourcePath: path.resolve(configPath) }]),
    ...(oauthInsideState
      ? []
      : [{ kind: "credentials" as const, sourcePath: path.resolve(oauthDir) }]),
    ...workspaceDirs.map((workspaceDir) => ({
      kind: "workspace" as const,
      sourcePath: path.resolve(workspaceDir),
    })),
  ];

  const candidates: BackupAssetCandidate[] = await Promise.all(
    rawCandidates.map(async (candidate) => {
      const exists = await pathExists(candidate.sourcePath);
      return {
        ...candidate,
        canonicalPath: exists
          ? await canonicalizeExistingPath(candidate.sourcePath)
          : path.resolve(candidate.sourcePath),
        exists,
      };
    }),
  );

  const uniqueCandidates: BackupAssetCandidate[] = [];
  const seenCanonicalPaths = new Set<string>();
  for (const candidate of [...candidates].toSorted(compareCandidates)) {
    if (seenCanonicalPaths.has(candidate.canonicalPath)) {
      continue;
    }
    seenCanonicalPaths.add(candidate.canonicalPath);
    uniqueCandidates.push(candidate);
  }
  const included: BackupAsset[] = [];
  const skipped: SkippedBackupAsset[] = [];

  for (const candidate of uniqueCandidates) {
    if (!candidate.exists) {
      skipped.push({
        displayPath: shortenHomePath(candidate.sourcePath),
        kind: candidate.kind,
        reason: "missing",
        sourcePath: candidate.sourcePath,
      });
      continue;
    }

    const coveredBy = included.find((asset) =>
      isPathWithin(candidate.canonicalPath, asset.sourcePath),
    );
    if (coveredBy) {
      skipped.push({
        coveredBy: coveredBy.displayPath,
        displayPath: shortenHomePath(candidate.canonicalPath),
        kind: candidate.kind,
        reason: "covered",
        sourcePath: candidate.canonicalPath,
      });
      continue;
    }

    included.push({
      archivePath: buildBackupArchivePath(archiveRoot, candidate.canonicalPath),
      displayPath: shortenHomePath(candidate.canonicalPath),
      kind: candidate.kind,
      sourcePath: candidate.canonicalPath,
    });
  }

  return {
    configPath,
    included,
    oauthDir,
    skipped,
    stateDir,
    workspaceDirs: workspaceDirs.map((entry) => path.resolve(entry)),
  };
}

function compareCandidates(left: BackupAssetCandidate, right: BackupAssetCandidate): number {
  const depthDelta = left.canonicalPath.length - right.canonicalPath.length;
  if (depthDelta !== 0) {
    return depthDelta;
  }
  const priorityDelta = backupAssetPriority(left.kind) - backupAssetPriority(right.kind);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return left.canonicalPath.localeCompare(right.canonicalPath);
}

async function canonicalizeExistingPath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export async function resolveBackupPlanFromDisk(
  params: {
    includeWorkspace?: boolean;
    onlyConfig?: boolean;
    nowMs?: number;
  } = {},
): Promise<BackupPlan> {
  const includeWorkspace = params.includeWorkspace ?? true;
  const onlyConfig = params.onlyConfig ?? false;
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();

  const configSnapshot = await readConfigFileSnapshot();
  if (includeWorkspace && configSnapshot.exists && !configSnapshot.valid) {
    throw new Error(
      `Config invalid at ${shortenHomePath(configSnapshot.path)}. OpenClaw cannot reliably discover custom workspaces for backup. Fix the config or rerun with --no-include-workspace for a partial backup.`,
    );
  }
  const cleanupPlan = buildCleanupPlan({
    cfg: configSnapshot.config,
    configPath,
    oauthDir,
    stateDir,
  });
  return await resolveBackupPlanFromPaths({
    configInsideState: cleanupPlan.configInsideState,
    configPath,
    includeWorkspace,
    nowMs: params.nowMs,
    oauthDir,
    oauthInsideState: cleanupPlan.oauthInsideState,
    onlyConfig,
    stateDir,
    workspaceDirs: includeWorkspace ? cleanupPlan.workspaceDirs : [],
  });
}
