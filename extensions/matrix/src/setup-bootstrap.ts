import { hasExplicitMatrixAccountConfig } from "./matrix/account-config.js";
import { resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { bootstrapMatrixVerification } from "./matrix/actions/verification.js";
import { formatMatrixErrorMessage } from "./matrix/errors.js";
import type { RuntimeEnv } from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

export interface MatrixSetupVerificationBootstrapResult {
  attempted: boolean;
  success: boolean;
  recoveryKeyCreatedAt: string | null;
  backupVersion: string | null;
  error?: string;
}

export async function maybeBootstrapNewEncryptedMatrixAccount(params: {
  previousCfg: CoreConfig;
  cfg: CoreConfig;
  accountId: string;
}): Promise<MatrixSetupVerificationBootstrapResult> {
  const accountConfig = resolveMatrixAccountConfig({
    accountId: params.accountId,
    cfg: params.cfg,
  });

  if (
    hasExplicitMatrixAccountConfig(params.previousCfg, params.accountId) ||
    accountConfig.encryption !== true
  ) {
    return {
      attempted: false,
      backupVersion: null,
      recoveryKeyCreatedAt: null,
      success: false,
    };
  }

  try {
    const bootstrap = await bootstrapMatrixVerification({ accountId: params.accountId });
    return {
      attempted: true,
      backupVersion: bootstrap.verification.backupVersion,
      recoveryKeyCreatedAt: bootstrap.verification.recoveryKeyCreatedAt,
      success: bootstrap.success,
      ...(bootstrap.success
        ? {}
        : { error: bootstrap.error ?? "Matrix verification bootstrap failed" }),
    };
  } catch (error) {
    return {
      attempted: true,
      backupVersion: null,
      error: formatMatrixErrorMessage(error),
      recoveryKeyCreatedAt: null,
      success: false,
    };
  }
}

export async function runMatrixSetupBootstrapAfterConfigWrite(params: {
  previousCfg: CoreConfig;
  cfg: CoreConfig;
  accountId: string;
  runtime: RuntimeEnv;
}): Promise<void> {
  const nextAccountConfig = resolveMatrixAccountConfig({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  if (nextAccountConfig.encryption !== true) {
    return;
  }

  const bootstrap = await maybeBootstrapNewEncryptedMatrixAccount({
    accountId: params.accountId,
    cfg: params.cfg,
    previousCfg: params.previousCfg,
  });
  if (!bootstrap.attempted) {
    return;
  }
  if (bootstrap.success) {
    params.runtime.log(`Matrix verification bootstrap: complete for "${params.accountId}".`);
    if (bootstrap.backupVersion) {
      params.runtime.log(
        `Matrix backup version for "${params.accountId}": ${bootstrap.backupVersion}`,
      );
    }
    return;
  }
  params.runtime.error(
    `Matrix verification bootstrap warning for "${params.accountId}": ${bootstrap.error ?? "unknown bootstrap failure"}`,
  );
}
