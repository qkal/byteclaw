import type { OpenClawConfig } from "./config-runtime.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

interface MatrixLegacyLog {
  info?: (message: string) => void;
  warn?: (message: string) => void;
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

interface MatrixLegacyMigrationResult {
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

type MatrixLegacyStateDetection = MatrixLegacyStatePlan | { warning: string } | null;

interface MatrixMigrationSnapshotResult {
  created: boolean;
  archivePath: string;
  markerPath: string;
}

interface MatrixRuntimeHeavyModule {
  autoPrepareLegacyMatrixCrypto: (params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    log?: MatrixLegacyLog;
    deps?: Partial<Record<string, unknown>>;
  }) => Promise<MatrixLegacyMigrationResult>;
  detectLegacyMatrixCrypto: (params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  }) => MatrixLegacyCryptoDetection;
  autoMigrateLegacyMatrixState: (params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    log?: MatrixLegacyLog;
  }) => Promise<MatrixLegacyMigrationResult>;
  detectLegacyMatrixState: (params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  }) => MatrixLegacyStateDetection;
  hasActionableMatrixMigration: (params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  }) => boolean;
  hasPendingMatrixMigration: (params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }) => boolean;
  maybeCreateMatrixMigrationSnapshot: (params: {
    trigger: string;
    env?: NodeJS.ProcessEnv;
    outputDir?: string;
    log?: MatrixLegacyLog;
  }) => Promise<MatrixMigrationSnapshotResult>;
}

function loadFacadeModule(): MatrixRuntimeHeavyModule {
  return loadBundledPluginPublicSurfaceModuleSync<MatrixRuntimeHeavyModule>({
    artifactBasename: "runtime-heavy-api.js",
    dirName: "matrix",
  });
}

export const autoPrepareLegacyMatrixCrypto: MatrixRuntimeHeavyModule["autoPrepareLegacyMatrixCrypto"] =
  ((...args) =>
    loadFacadeModule().autoPrepareLegacyMatrixCrypto(
      ...args,
    )) as MatrixRuntimeHeavyModule["autoPrepareLegacyMatrixCrypto"];
export const detectLegacyMatrixCrypto: MatrixRuntimeHeavyModule["detectLegacyMatrixCrypto"] = ((
  ...args
) =>
  loadFacadeModule().detectLegacyMatrixCrypto(
    ...args,
  )) as MatrixRuntimeHeavyModule["detectLegacyMatrixCrypto"];
export const autoMigrateLegacyMatrixState: MatrixRuntimeHeavyModule["autoMigrateLegacyMatrixState"] =
  ((...args) =>
    loadFacadeModule().autoMigrateLegacyMatrixState(
      ...args,
    )) as MatrixRuntimeHeavyModule["autoMigrateLegacyMatrixState"];
export const detectLegacyMatrixState: MatrixRuntimeHeavyModule["detectLegacyMatrixState"] = ((
  ...args
) =>
  loadFacadeModule().detectLegacyMatrixState(
    ...args,
  )) as MatrixRuntimeHeavyModule["detectLegacyMatrixState"];
export const hasActionableMatrixMigration: MatrixRuntimeHeavyModule["hasActionableMatrixMigration"] =
  ((...args) =>
    loadFacadeModule().hasActionableMatrixMigration(
      ...args,
    )) as MatrixRuntimeHeavyModule["hasActionableMatrixMigration"];
export const hasPendingMatrixMigration: MatrixRuntimeHeavyModule["hasPendingMatrixMigration"] = ((
  ...args
) =>
  loadFacadeModule().hasPendingMatrixMigration(
    ...args,
  )) as MatrixRuntimeHeavyModule["hasPendingMatrixMigration"];
export const maybeCreateMatrixMigrationSnapshot: MatrixRuntimeHeavyModule["maybeCreateMatrixMigrationSnapshot"] =
  ((...args) =>
    loadFacadeModule().maybeCreateMatrixMigrationSnapshot(
      ...args,
    )) as MatrixRuntimeHeavyModule["maybeCreateMatrixMigrationSnapshot"];
