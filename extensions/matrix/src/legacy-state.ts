import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveLegacyMatrixFlatStoreTarget } from "./migration-config.js";
import { resolveMatrixLegacyFlatStoragePaths } from "./storage-paths.js";

export interface MatrixLegacyStateMigrationResult {
  migrated: boolean;
  changes: string[];
  warnings: string[];
}

interface MatrixLegacyStatePlan {
  accountId: string;
  legacyStoragePath: string;
  legacyCryptoPath: string;
  targetRootDir: string;
  targetStoragePath: string;
  targetCryptoPath: string;
  selectionNote?: string;
}

function resolveLegacyMatrixPaths(env: NodeJS.ProcessEnv): {
  rootDir: string;
  storagePath: string;
  cryptoPath: string;
} {
  const stateDir = resolveStateDir(env, os.homedir);
  return resolveMatrixLegacyFlatStoragePaths(stateDir);
}

function resolveMatrixMigrationPlan(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): MatrixLegacyStatePlan | { warning: string } | null {
  const legacy = resolveLegacyMatrixPaths(params.env);
  if (!fs.existsSync(legacy.storagePath) && !fs.existsSync(legacy.cryptoPath)) {
    return null;
  }

  const target = resolveLegacyMatrixFlatStoreTarget({
    cfg: params.cfg,
    detectedKind: "state",
    detectedPath: legacy.rootDir,
    env: params.env,
  });
  if ("warning" in target) {
    return target;
  }

  return {
    accountId: target.accountId,
    legacyCryptoPath: legacy.cryptoPath,
    legacyStoragePath: legacy.storagePath,
    selectionNote: target.selectionNote,
    targetCryptoPath: path.join(target.rootDir, "crypto"),
    targetRootDir: target.rootDir,
    targetStoragePath: path.join(target.rootDir, "bot-storage.json"),
  };
}

export function detectLegacyMatrixState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MatrixLegacyStatePlan | { warning: string } | null {
  return resolveMatrixMigrationPlan({
    cfg: params.cfg,
    env: params.env ?? process.env,
  });
}

function moveLegacyPath(params: {
  sourcePath: string;
  targetPath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): void {
  if (!fs.existsSync(params.sourcePath)) {
    return;
  }
  if (fs.existsSync(params.targetPath)) {
    params.warnings.push(
      `Matrix legacy ${params.label} not migrated because the target already exists (${params.targetPath}).`,
    );
    return;
  }
  try {
    fs.mkdirSync(path.dirname(params.targetPath), { recursive: true });
    fs.renameSync(params.sourcePath, params.targetPath);
    params.changes.push(
      `Migrated Matrix legacy ${params.label}: ${params.sourcePath} -> ${params.targetPath}`,
    );
  } catch (error) {
    params.warnings.push(
      `Failed migrating Matrix legacy ${params.label} (${params.sourcePath} -> ${params.targetPath}): ${String(error)}`,
    );
  }
}

export async function autoMigrateLegacyMatrixState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<MatrixLegacyStateMigrationResult> {
  const env = params.env ?? process.env;
  const detection = detectLegacyMatrixState({ cfg: params.cfg, env });
  if (!detection) {
    return { changes: [], migrated: false, warnings: [] };
  }
  if ("warning" in detection) {
    params.log?.warn?.(`matrix: ${detection.warning}`);
    return { changes: [], migrated: false, warnings: [detection.warning] };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  moveLegacyPath({
    changes,
    label: "sync store",
    sourcePath: detection.legacyStoragePath,
    targetPath: detection.targetStoragePath,
    warnings,
  });
  moveLegacyPath({
    changes,
    label: "crypto store",
    sourcePath: detection.legacyCryptoPath,
    targetPath: detection.targetCryptoPath,
    warnings,
  });

  if (changes.length > 0) {
    const details = [
      ...changes.map((entry) => `- ${entry}`),
      ...(detection.selectionNote ? [`- ${detection.selectionNote}`] : []),
      "- No user action required.",
    ];
    params.log?.info?.(
      `matrix: plugin upgraded in place for account "${detection.accountId}".\n${details.join("\n")}`,
    );
  }
  if (warnings.length > 0) {
    params.log?.warn?.(
      `matrix: legacy state migration warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }

  return {
    changes,
    migrated: changes.length > 0,
    warnings,
  };
}
