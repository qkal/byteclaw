import {
  type NpmSpecResolution as NpmResolutionMetadata,
  buildNpmResolutionFields,
} from "../infra/install-source-utils.js";

export function resolvePinnedNpmSpec(params: {
  rawSpec: string;
  pin: boolean;
  resolvedSpec?: string;
}): { recordSpec: string; pinWarning?: string; pinNotice?: string } {
  const recordSpec = params.pin && params.resolvedSpec ? params.resolvedSpec : params.rawSpec;
  if (!params.pin) {
    return { recordSpec };
  }
  if (!params.resolvedSpec) {
    return {
      pinWarning: "Could not resolve exact npm version for --pin; storing original npm spec.",
      recordSpec,
    };
  }
  return {
    pinNotice: `Pinned npm install record to ${params.resolvedSpec}.`,
    recordSpec,
  };
}

export function mapNpmResolutionMetadata(resolution?: NpmResolutionMetadata): {
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
} {
  return buildNpmResolutionFields(resolution);
}

export function buildNpmInstallRecordFields(params: {
  spec: string;
  installPath: string;
  version?: string;
  resolution?: NpmResolutionMetadata;
}): {
  source: "npm";
  spec: string;
  installPath: string;
  version?: string;
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
} {
  return {
    installPath: params.installPath,
    source: "npm",
    spec: params.spec,
    version: params.version,
    ...buildNpmResolutionFields(params.resolution),
  };
}

export function resolvePinnedNpmInstallRecord(params: {
  rawSpec: string;
  pin: boolean;
  installPath: string;
  version?: string;
  resolution?: NpmResolutionMetadata;
  log: (message: string) => void;
  warn: (message: string) => void;
}): ReturnType<typeof buildNpmInstallRecordFields> {
  const pinInfo = resolvePinnedNpmSpec({
    pin: params.pin,
    rawSpec: params.rawSpec,
    resolvedSpec: params.resolution?.resolvedSpec,
  });
  logPinnedNpmSpecMessages(pinInfo, params.log, params.warn);
  return buildNpmInstallRecordFields({
    installPath: params.installPath,
    resolution: params.resolution,
    spec: pinInfo.recordSpec,
    version: params.version,
  });
}

export function resolvePinnedNpmInstallRecordForCli(
  rawSpec: string,
  pin: boolean,
  installPath: string,
  version: string | undefined,
  resolution: NpmResolutionMetadata | undefined,
  log: (message: string) => void,
  warnFormat: (message: string) => string,
): ReturnType<typeof buildNpmInstallRecordFields> {
  return resolvePinnedNpmInstallRecord({
    installPath,
    log,
    pin,
    rawSpec,
    resolution,
    version,
    warn: (message) => log(warnFormat(message)),
  });
}

export function logPinnedNpmSpecMessages(
  pinInfo: { pinWarning?: string; pinNotice?: string },
  log: (message: string) => void,
  logWarn: (message: string) => void,
): void {
  if (pinInfo.pinWarning) {
    logWarn(pinInfo.pinWarning);
  }
  if (pinInfo.pinNotice) {
    log(pinInfo.pinNotice);
  }
}
