import fs from "node:fs";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SsrFPolicy } from "../../runtime-api.js";
import type { MatrixClient } from "../sdk.js";
import { resolveValidatedMatrixHomeserverUrl } from "./config.js";
import {
  maybeMigrateLegacyStorage,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./storage.js";

interface MatrixCreateClientRuntimeDeps {
  MatrixClient: typeof import("../sdk.js").MatrixClient;
  ensureMatrixSdkLoggingConfigured: typeof import("./logging.js").ensureMatrixSdkLoggingConfigured;
}

let matrixCreateClientRuntimeDepsPromise: Promise<MatrixCreateClientRuntimeDeps> | undefined;

async function loadMatrixCreateClientRuntimeDeps(): Promise<MatrixCreateClientRuntimeDeps> {
  matrixCreateClientRuntimeDepsPromise ??= Promise.all([
    import("../sdk.js"),
    import("./logging.js"),
  ]).then(([sdkModule, loggingModule]) => ({
    MatrixClient: sdkModule.MatrixClient,
    ensureMatrixSdkLoggingConfigured: loggingModule.ensureMatrixSdkLoggingConfigured,
  }));
  return await matrixCreateClientRuntimeDepsPromise;
}

export async function createMatrixClient(params: {
  homeserver: string;
  userId?: string;
  accessToken: string;
  password?: string;
  deviceId?: string;
  persistStorage?: boolean;
  encryption?: boolean;
  localTimeoutMs?: number;
  initialSyncLimit?: number;
  accountId?: string | null;
  autoBootstrapCrypto?: boolean;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): Promise<MatrixClient> {
  const { MatrixClient, ensureMatrixSdkLoggingConfigured } =
    await loadMatrixCreateClientRuntimeDeps();
  ensureMatrixSdkLoggingConfigured();
  const homeserver = await resolveValidatedMatrixHomeserverUrl(params.homeserver, {
    dangerouslyAllowPrivateNetwork: params.allowPrivateNetwork,
  });
  const matrixClientUserId = normalizeOptionalString(params.userId);
  const userId = matrixClientUserId ?? "unknown";
  const persistStorage = params.persistStorage !== false;
  const storagePaths = persistStorage
    ? resolveMatrixStoragePaths({
        accessToken: params.accessToken,
        accountId: params.accountId,
        deviceId: params.deviceId,
        env: process.env,
        homeserver,
        userId,
      })
    : null;

  if (storagePaths) {
    await maybeMigrateLegacyStorage({
      env: process.env,
      storagePaths,
    });
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    writeStorageMeta({
      accountId: params.accountId,
      deviceId: params.deviceId,
      homeserver,
      storagePaths,
      userId,
    });
  }

  const cryptoDatabasePrefix = storagePaths
    ? `openclaw-matrix-${storagePaths.accountKey}-${storagePaths.tokenHash}`
    : undefined;

  return new MatrixClient(homeserver, params.accessToken, {
    autoBootstrapCrypto: params.autoBootstrapCrypto,
    cryptoDatabasePrefix,
    deviceId: params.deviceId,
    dispatcherPolicy: params.dispatcherPolicy,
    encryption: params.encryption,
    idbSnapshotPath: storagePaths?.idbSnapshotPath,
    initialSyncLimit: params.initialSyncLimit,
    localTimeoutMs: params.localTimeoutMs,
    password: params.password,
    recoveryKeyPath: storagePaths?.recoveryKeyPath,
    ssrfPolicy: params.ssrfPolicy,
    storagePath: storagePaths?.storagePath,
    userId: matrixClientUserId,
  });
}
