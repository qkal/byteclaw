import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  autoMigrateLegacyMatrixState,
  autoPrepareLegacyMatrixCrypto,
  hasActionableMatrixMigration,
  hasPendingMatrixMigration,
  maybeCreateMatrixMigrationSnapshot,
} from "./matrix-migration.runtime.js";

interface MatrixStartupLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

async function runBestEffortMatrixMigrationStep(params: {
  label: string;
  log: MatrixStartupLogger;
  logPrefix?: string;
  run: () => Promise<unknown>;
}): Promise<void> {
  try {
    await params.run();
  } catch (error) {
    params.log.warn?.(
      `${params.logPrefix?.trim() || "gateway"}: ${params.label} failed during Matrix migration; continuing startup: ${String(error)}`,
    );
  }
}

export async function runMatrixStartupMaintenance(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: MatrixStartupLogger;
  trigger?: string;
  logPrefix?: string;
  deps?: {
    maybeCreateMatrixMigrationSnapshot?: typeof maybeCreateMatrixMigrationSnapshot;
    autoMigrateLegacyMatrixState?: typeof autoMigrateLegacyMatrixState;
    autoPrepareLegacyMatrixCrypto?: typeof autoPrepareLegacyMatrixCrypto;
  };
}): Promise<void> {
  const env = params.env ?? process.env;
  const createSnapshot =
    params.deps?.maybeCreateMatrixMigrationSnapshot ?? maybeCreateMatrixMigrationSnapshot;
  const migrateLegacyState =
    params.deps?.autoMigrateLegacyMatrixState ?? autoMigrateLegacyMatrixState;
  const prepareLegacyCrypto =
    params.deps?.autoPrepareLegacyMatrixCrypto ?? autoPrepareLegacyMatrixCrypto;
  const trigger = params.trigger?.trim() || "gateway-startup";
  const logPrefix = params.logPrefix?.trim() || "gateway";
  const actionable = hasActionableMatrixMigration({ cfg: params.cfg, env });
  const pending = actionable || hasPendingMatrixMigration({ cfg: params.cfg, env });

  if (!pending) {
    return;
  }
  if (!actionable) {
    params.log.info?.(
      "matrix: migration remains in a warning-only state; no pre-migration snapshot was needed yet",
    );
    return;
  }

  try {
    await createSnapshot({
      env,
      log: params.log,
      trigger,
    });
  } catch (error) {
    params.log.warn?.(
      `${logPrefix}: failed creating a Matrix migration snapshot; skipping Matrix migration for now: ${String(error)}`,
    );
    return;
  }

  await runBestEffortMatrixMigrationStep({
    label: "legacy Matrix state migration",
    log: params.log,
    logPrefix,
    run: () =>
      migrateLegacyState({
        cfg: params.cfg,
        env,
        log: params.log,
      }),
  });
  await runBestEffortMatrixMigrationStep({
    label: "legacy Matrix encrypted-state preparation",
    log: params.log,
    logPrefix,
    run: () =>
      prepareLegacyCrypto({
        cfg: params.cfg,
        env,
        log: params.log,
      }),
  });
}
