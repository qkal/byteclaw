import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { writeJsonFileAtomically as writeJsonFileAtomicallyImpl } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveConfiguredMatrixAccountIds } from "./account-selection.js";
import { isMatrixLegacyCryptoInspectorAvailable } from "./legacy-crypto-inspector-availability.js";
import { formatMatrixErrorMessage } from "./matrix/errors.js";
import {
  resolveLegacyMatrixFlatStoreTarget,
  resolveMatrixMigrationAccountTarget,
} from "./migration-config.js";
import { resolveMatrixLegacyFlatStoragePaths } from "./storage-paths.js";

const MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE =
  "Legacy Matrix encrypted state was detected, but the Matrix crypto inspector is unavailable.";

interface MatrixLegacyCryptoCounts {
  total: number;
  backedUp: number;
}

interface MatrixLegacyCryptoSummary {
  deviceId: string | null;
  roomKeyCounts: MatrixLegacyCryptoCounts | null;
  backupVersion: string | null;
  decryptionKeyBase64: string | null;
}

interface MatrixLegacyCryptoMigrationState {
  version: 1;
  source: "matrix-bot-sdk-rust";
  accountId: string;
  deviceId: string | null;
  roomKeyCounts: MatrixLegacyCryptoCounts | null;
  backupVersion: string | null;
  decryptionKeyImported: boolean;
  restoreStatus: "pending" | "completed" | "manual-action-required";
  detectedAt: string;
  restoredAt?: string;
  importedCount?: number;
  totalCount?: number;
  lastError?: string | null;
}

interface MatrixLegacyCryptoPlan {
  accountId: string;
  rootDir: string;
  recoveryKeyPath: string;
  statePath: string;
  legacyCryptoPath: string;
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string | null;
}

interface MatrixLegacyCryptoDetection {
  plans: MatrixLegacyCryptoPlan[];
  warnings: string[];
}

interface MatrixLegacyCryptoPreparationResult {
  migrated: boolean;
  changes: string[];
  warnings: string[];
}

interface MatrixLegacyCryptoPrepareDeps {
  inspectLegacyStore: MatrixLegacyCryptoInspector;
  writeJsonFileAtomically: typeof writeJsonFileAtomicallyImpl;
}

interface MatrixLegacyCryptoInspectorParams {
  cryptoRootDir: string;
  userId: string;
  deviceId: string;
  log?: (message: string) => void;
}

interface MatrixLegacyCryptoInspectorResult {
  deviceId: string | null;
  roomKeyCounts: {
    total: number;
    backedUp: number;
  } | null;
  backupVersion: string | null;
  decryptionKeyBase64: string | null;
}

type MatrixLegacyCryptoInspector = (
  params: MatrixLegacyCryptoInspectorParams,
) => Promise<MatrixLegacyCryptoInspectorResult>;

interface MatrixLegacyBotSdkMetadata {
  deviceId: string | null;
}

interface MatrixStoredRecoveryKey {
  version: 1;
  createdAt: string;
  keyId?: string | null;
  encodedPrivateKey?: string;
  privateKeyBase64: string;
  keyInfo?: {
    passphrase?: unknown;
    name?: string;
  };
}

async function loadMatrixLegacyCryptoInspector(): Promise<MatrixLegacyCryptoInspector> {
  const module = await import("./matrix/legacy-crypto-inspector.js");
  return module.inspectLegacyMatrixCryptoStore as MatrixLegacyCryptoInspector;
}

function detectLegacyBotSdkCryptoStore(cryptoRootDir: string): {
  detected: boolean;
  warning?: string;
} {
  try {
    const stat = fs.statSync(cryptoRootDir);
    if (!stat.isDirectory()) {
      return {
        detected: false,
        warning:
          `Legacy Matrix encrypted state path exists but is not a directory: ${cryptoRootDir}. ` +
          "OpenClaw skipped automatic crypto migration for that path.",
      };
    }
  } catch (error) {
    return {
      detected: false,
      warning:
        `Failed reading legacy Matrix encrypted state path (${cryptoRootDir}): ${String(error)}. ` +
        "OpenClaw skipped automatic crypto migration for that path.",
    };
  }

  try {
    return {
      detected:
        fs.existsSync(path.join(cryptoRootDir, "bot-sdk.json")) ||
        fs.existsSync(path.join(cryptoRootDir, "matrix-sdk-crypto.sqlite3")) ||
        fs
          .readdirSync(cryptoRootDir, { withFileTypes: true })
          .some(
            (entry) =>
              entry.isDirectory() &&
              fs.existsSync(path.join(cryptoRootDir, entry.name, "matrix-sdk-crypto.sqlite3")),
          ),
    };
  } catch (error) {
    return {
      detected: false,
      warning:
        `Failed scanning legacy Matrix encrypted state path (${cryptoRootDir}): ${String(error)}. ` +
        "OpenClaw skipped automatic crypto migration for that path.",
    };
  }
}

function resolveMatrixAccountIds(cfg: OpenClawConfig): string[] {
  return resolveConfiguredMatrixAccountIds(cfg);
}

function resolveLegacyMatrixFlatStorePlan(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): MatrixLegacyCryptoPlan | { warning: string } | null {
  const legacy = resolveMatrixLegacyFlatStoragePaths(resolveStateDir(params.env, os.homedir));
  if (!fs.existsSync(legacy.cryptoPath)) {
    return null;
  }
  const legacyStore = detectLegacyBotSdkCryptoStore(legacy.cryptoPath);
  if (legacyStore.warning) {
    return { warning: legacyStore.warning };
  }
  if (!legacyStore.detected) {
    return null;
  }

  const target = resolveLegacyMatrixFlatStoreTarget({
    cfg: params.cfg,
    detectedKind: "encrypted state",
    detectedPath: legacy.cryptoPath,
    env: params.env,
  });
  if ("warning" in target) {
    return target;
  }

  const metadata = loadLegacyBotSdkMetadata(legacy.cryptoPath);
  return {
    accessToken: target.accessToken,
    accountId: target.accountId,
    deviceId: metadata.deviceId ?? target.storedDeviceId,
    homeserver: target.homeserver,
    legacyCryptoPath: legacy.cryptoPath,
    recoveryKeyPath: path.join(target.rootDir, "recovery-key.json"),
    rootDir: target.rootDir,
    statePath: path.join(target.rootDir, "legacy-crypto-migration.json"),
    userId: target.userId,
  };
}

function loadLegacyBotSdkMetadata(cryptoRootDir: string): MatrixLegacyBotSdkMetadata {
  const metadataPath = path.join(cryptoRootDir, "bot-sdk.json");
  const fallback: MatrixLegacyBotSdkMetadata = { deviceId: null };
  try {
    if (!fs.existsSync(metadataPath)) {
      return fallback;
    }
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      deviceId?: unknown;
    };
    return {
      deviceId:
        typeof parsed.deviceId === "string" && parsed.deviceId.trim() ? parsed.deviceId : null,
    };
  } catch {
    return fallback;
  }
}

function resolveMatrixLegacyCryptoPlans(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): MatrixLegacyCryptoDetection {
  const warnings: string[] = [];
  const plans: MatrixLegacyCryptoPlan[] = [];

  const flatPlan = resolveLegacyMatrixFlatStorePlan(params);
  if (flatPlan) {
    if ("warning" in flatPlan) {
      warnings.push(flatPlan.warning);
    } else {
      plans.push(flatPlan);
    }
  }

  for (const accountId of resolveMatrixAccountIds(params.cfg)) {
    const target = resolveMatrixMigrationAccountTarget({
      accountId,
      cfg: params.cfg,
      env: params.env,
    });
    if (!target) {
      continue;
    }
    const legacyCryptoPath = path.join(target.rootDir, "crypto");
    if (!fs.existsSync(legacyCryptoPath)) {
      continue;
    }
    const detectedStore = detectLegacyBotSdkCryptoStore(legacyCryptoPath);
    if (detectedStore.warning) {
      warnings.push(detectedStore.warning);
      continue;
    }
    if (!detectedStore.detected) {
      continue;
    }
    if (
      plans.some(
        (plan) =>
          plan.accountId === accountId &&
          path.resolve(plan.legacyCryptoPath) === path.resolve(legacyCryptoPath),
      )
    ) {
      continue;
    }
    const metadata = loadLegacyBotSdkMetadata(legacyCryptoPath);
    plans.push({
      accessToken: target.accessToken,
      accountId: target.accountId,
      deviceId: metadata.deviceId ?? target.storedDeviceId,
      homeserver: target.homeserver,
      legacyCryptoPath,
      recoveryKeyPath: path.join(target.rootDir, "recovery-key.json"),
      rootDir: target.rootDir,
      statePath: path.join(target.rootDir, "legacy-crypto-migration.json"),
      userId: target.userId,
    });
  }

  return { plans, warnings };
}

function loadStoredRecoveryKey(filePath: string): MatrixStoredRecoveryKey | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as MatrixStoredRecoveryKey;
  } catch {
    return null;
  }
}

function loadLegacyCryptoMigrationState(filePath: string): MatrixLegacyCryptoMigrationState | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as MatrixLegacyCryptoMigrationState;
  } catch {
    return null;
  }
}

async function persistLegacyMigrationState(params: {
  filePath: string;
  state: MatrixLegacyCryptoMigrationState;
  writeJsonFileAtomically: typeof writeJsonFileAtomicallyImpl;
}): Promise<void> {
  await params.writeJsonFileAtomically(params.filePath, params.state);
}

export function detectLegacyMatrixCrypto(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MatrixLegacyCryptoDetection {
  const detection = resolveMatrixLegacyCryptoPlans({
    cfg: params.cfg,
    env: params.env ?? process.env,
  });
  if (detection.plans.length > 0 && !isMatrixLegacyCryptoInspectorAvailable()) {
    return {
      plans: detection.plans,
      warnings: [...detection.warnings, MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE],
    };
  }
  return detection;
}

export async function autoPrepareLegacyMatrixCrypto(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
  deps?: Partial<MatrixLegacyCryptoPrepareDeps>;
}): Promise<MatrixLegacyCryptoPreparationResult> {
  const env = params.env ?? process.env;
  const detection = params.deps?.inspectLegacyStore
    ? resolveMatrixLegacyCryptoPlans({ cfg: params.cfg, env })
    : detectLegacyMatrixCrypto({ cfg: params.cfg, env });
  const warnings = [...detection.warnings];
  const changes: string[] = [];
  const writeJsonFileAtomically =
    params.deps?.writeJsonFileAtomically ?? writeJsonFileAtomicallyImpl;
  if (detection.plans.length === 0) {
    if (warnings.length > 0) {
      params.log?.warn?.(
        `matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
    return {
      changes,
      migrated: false,
      warnings,
    };
  }
  if (!params.deps?.inspectLegacyStore && !isMatrixLegacyCryptoInspectorAvailable()) {
    if (warnings.length > 0) {
      params.log?.warn?.(
        `matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
    return {
      changes,
      migrated: false,
      warnings,
    };
  }

  let inspectLegacyStore = params.deps?.inspectLegacyStore;
  if (!inspectLegacyStore) {
    try {
      inspectLegacyStore = await loadMatrixLegacyCryptoInspector();
    } catch (error) {
      const message = formatMatrixErrorMessage(error);
      if (!warnings.includes(message)) {
        warnings.push(message);
      }
      if (warnings.length > 0) {
        params.log?.warn?.(
          `matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
        );
      }
      return {
        changes,
        migrated: false,
        warnings,
      };
    }
  }
  if (!inspectLegacyStore) {
    return {
      changes,
      migrated: false,
      warnings,
    };
  }

  for (const plan of detection.plans) {
    const existingState = loadLegacyCryptoMigrationState(plan.statePath);
    if (existingState?.version === 1) {
      continue;
    }
    if (!plan.deviceId) {
      warnings.push(
        `Legacy Matrix encrypted state detected at ${plan.legacyCryptoPath}, but no device ID was found for account "${plan.accountId}". ` +
          `OpenClaw will continue, but old encrypted history cannot be recovered automatically.`,
      );
      continue;
    }

    let summary: MatrixLegacyCryptoSummary;
    try {
      summary = await inspectLegacyStore({
        cryptoRootDir: plan.legacyCryptoPath,
        deviceId: plan.deviceId,
        log: params.log?.info,
        userId: plan.userId,
      });
    } catch (error) {
      warnings.push(
        `Failed inspecting legacy Matrix encrypted state for account "${plan.accountId}" (${plan.legacyCryptoPath}): ${String(error)}`,
      );
      continue;
    }

    let decryptionKeyImported = false;
    if (summary.decryptionKeyBase64) {
      const existingRecoveryKey = loadStoredRecoveryKey(plan.recoveryKeyPath);
      if (
        existingRecoveryKey?.privateKeyBase64 &&
        existingRecoveryKey.privateKeyBase64 !== summary.decryptionKeyBase64
      ) {
        warnings.push(
          `Legacy Matrix backup key was found for account "${plan.accountId}", but ${plan.recoveryKeyPath} already contains a different recovery key. Leaving the existing file unchanged.`,
        );
      } else if (!existingRecoveryKey?.privateKeyBase64) {
        const payload: MatrixStoredRecoveryKey = {
          createdAt: new Date().toISOString(),
          keyId: null,
          privateKeyBase64: summary.decryptionKeyBase64,
          version: 1,
        };
        try {
          await writeJsonFileAtomically(plan.recoveryKeyPath, payload);
          changes.push(
            `Imported Matrix legacy backup key for account "${plan.accountId}": ${plan.recoveryKeyPath}`,
          );
          decryptionKeyImported = true;
        } catch (error) {
          warnings.push(
            `Failed writing Matrix recovery key for account "${plan.accountId}" (${plan.recoveryKeyPath}): ${String(error)}`,
          );
        }
      } else {
        decryptionKeyImported = true;
      }
    }

    const localOnlyKeys =
      summary.roomKeyCounts && summary.roomKeyCounts.total > summary.roomKeyCounts.backedUp
        ? summary.roomKeyCounts.total - summary.roomKeyCounts.backedUp
        : 0;
    if (localOnlyKeys > 0) {
      warnings.push(
        `Legacy Matrix encrypted state for account "${plan.accountId}" contains ${localOnlyKeys} room key(s) that were never backed up. ` +
          "Backed-up keys can be restored automatically, but local-only encrypted history may remain unavailable after upgrade.",
      );
    }
    if (!summary.decryptionKeyBase64 && (summary.roomKeyCounts?.backedUp ?? 0) > 0) {
      warnings.push(
        `Legacy Matrix encrypted state for account "${plan.accountId}" has backed-up room keys, but no local backup decryption key was found. ` +
          `Ask the operator to run "openclaw matrix verify backup restore --recovery-key <key>" after upgrade if they have the recovery key.`,
      );
    }
    if (!summary.decryptionKeyBase64 && (summary.roomKeyCounts?.total ?? 0) > 0) {
      warnings.push(
        `Legacy Matrix encrypted state for account "${plan.accountId}" cannot be fully converted automatically because the old rust crypto store does not expose all local room keys for export.`,
      );
    }
    // If recovery-key persistence failed, leave the migration state absent so the next startup can retry.
    if (
      summary.decryptionKeyBase64 &&
      !decryptionKeyImported &&
      !loadStoredRecoveryKey(plan.recoveryKeyPath)
    ) {
      continue;
    }

    const state: MatrixLegacyCryptoMigrationState = {
      accountId: plan.accountId,
      backupVersion: summary.backupVersion,
      decryptionKeyImported,
      detectedAt: new Date().toISOString(),
      deviceId: summary.deviceId,
      lastError: null,
      restoreStatus: decryptionKeyImported ? "pending" : "manual-action-required",
      roomKeyCounts: summary.roomKeyCounts,
      source: "matrix-bot-sdk-rust",
      version: 1,
    };
    try {
      await persistLegacyMigrationState({
        filePath: plan.statePath,
        state,
        writeJsonFileAtomically,
      });
      changes.push(
        `Prepared Matrix legacy encrypted-state migration for account "${plan.accountId}": ${plan.statePath}`,
      );
    } catch (error) {
      warnings.push(
        `Failed writing Matrix legacy encrypted-state migration record for account "${plan.accountId}" (${plan.statePath}): ${String(error)}`,
      );
    }
  }

  if (changes.length > 0) {
    params.log?.info?.(
      `matrix: prepared encrypted-state upgrade.\n${changes.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
  if (warnings.length > 0) {
    params.log?.warn?.(
      `matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }

  return {
    changes,
    migrated: changes.length > 0,
    warnings,
  };
}
