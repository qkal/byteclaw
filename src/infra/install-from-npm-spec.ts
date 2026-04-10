import type { NpmIntegrityDriftPayload } from "./npm-integrity.js";
import {
  type NpmSpecArchiveFinalInstallResult,
  finalizeNpmSpecArchiveInstall,
  installFromNpmSpecArchiveWithInstaller,
} from "./npm-pack-install.js";
import { validateRegistryNpmSpec } from "./npm-registry-spec.js";

export async function installFromValidatedNpmSpecArchive<
  TResult extends { ok: boolean },
  TArchiveInstallParams extends { archivePath: string },
>(params: {
  spec: string;
  timeoutMs: number;
  tempDirPrefix: string;
  expectedIntegrity?: string;
  onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
  warn?: (message: string) => void;
  installFromArchive: (params: TArchiveInstallParams) => Promise<TResult>;
  archiveInstallParams: Omit<TArchiveInstallParams, "archivePath">;
}): Promise<NpmSpecArchiveFinalInstallResult<TResult>> {
  const spec = params.spec.trim();
  const specError = validateRegistryNpmSpec(spec);
  if (specError) {
    return { error: specError, ok: false };
  }
  const flowResult = await installFromNpmSpecArchiveWithInstaller({
    archiveInstallParams: params.archiveInstallParams,
    expectedIntegrity: params.expectedIntegrity,
    installFromArchive: params.installFromArchive,
    onIntegrityDrift: params.onIntegrityDrift,
    spec,
    tempDirPrefix: params.tempDirPrefix,
    timeoutMs: params.timeoutMs,
    warn: params.warn,
  });
  return finalizeNpmSpecArchiveInstall(flowResult);
}
