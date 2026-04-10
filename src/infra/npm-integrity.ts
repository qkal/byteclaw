import type { NpmIntegrityDrift, NpmSpecResolution } from "./install-source-utils.js";

export interface NpmIntegrityDriftPayload {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
}

interface ResolveNpmIntegrityDriftParams<TPayload> {
  spec: string;
  expectedIntegrity?: string;
  resolution: NpmSpecResolution;
  createPayload: (params: {
    spec: string;
    expectedIntegrity: string;
    actualIntegrity: string;
    resolution: NpmSpecResolution;
  }) => TPayload;
  onIntegrityDrift?: (payload: TPayload) => boolean | Promise<boolean>;
  warn?: (payload: TPayload) => void;
}

export interface ResolveNpmIntegrityDriftResult<TPayload> {
  integrityDrift?: NpmIntegrityDrift;
  proceed: boolean;
  payload?: TPayload;
}

export async function resolveNpmIntegrityDrift<TPayload>(
  params: ResolveNpmIntegrityDriftParams<TPayload>,
): Promise<ResolveNpmIntegrityDriftResult<TPayload>> {
  if (!params.expectedIntegrity || !params.resolution.integrity) {
    return { proceed: true };
  }
  if (params.expectedIntegrity === params.resolution.integrity) {
    return { proceed: true };
  }

  const integrityDrift: NpmIntegrityDrift = {
    actualIntegrity: params.resolution.integrity,
    expectedIntegrity: params.expectedIntegrity,
  };
  const payload = params.createPayload({
    actualIntegrity: integrityDrift.actualIntegrity,
    expectedIntegrity: integrityDrift.expectedIntegrity,
    resolution: params.resolution,
    spec: params.spec,
  });

  let proceed = true;
  if (params.onIntegrityDrift) {
    proceed = await params.onIntegrityDrift(payload);
  } else {
    params.warn?.(payload);
  }

  return { integrityDrift, payload, proceed };
}

interface ResolveNpmIntegrityDriftWithDefaultMessageParams {
  spec: string;
  expectedIntegrity?: string;
  resolution: NpmSpecResolution;
  onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
  warn?: (message: string) => void;
}

export async function resolveNpmIntegrityDriftWithDefaultMessage(
  params: ResolveNpmIntegrityDriftWithDefaultMessageParams,
): Promise<{ integrityDrift?: NpmIntegrityDrift; error?: string }> {
  const driftResult = await resolveNpmIntegrityDrift<NpmIntegrityDriftPayload>({
    createPayload: (drift) => ({ ...drift }),
    expectedIntegrity: params.expectedIntegrity,
    onIntegrityDrift: params.onIntegrityDrift,
    resolution: params.resolution,
    spec: params.spec,
    warn: (driftPayload) => {
      params.warn?.(
        `Integrity drift detected for ${driftPayload.resolution.resolvedSpec ?? driftPayload.spec}: expected ${driftPayload.expectedIntegrity}, got ${driftPayload.actualIntegrity}`,
      );
    },
  });

  if (!driftResult.proceed && driftResult.payload) {
    return {
      error: `aborted: npm package integrity drift detected for ${driftResult.payload.resolution.resolvedSpec ?? driftResult.payload.spec}`,
      integrityDrift: driftResult.integrityDrift,
    };
  }

  return { integrityDrift: driftResult.integrityDrift };
}
