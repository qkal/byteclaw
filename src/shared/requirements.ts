export interface Requirements {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}

export interface RequirementConfigCheck {
  path: string;
  satisfied: boolean;
}

export interface RequirementsMetadata {
  requires?: Partial<Pick<Requirements, "bins" | "anyBins" | "env" | "config">>;
  os?: string[];
}

export interface RequirementRemote {
  hasBin?: (bin: string) => boolean;
  hasAnyBin?: (bins: string[]) => boolean;
  platforms?: string[];
}

interface RequirementsEvaluationContext {
  always: boolean;
  hasLocalBin: (bin: string) => boolean;
  localPlatform: string;
  isEnvSatisfied: (envName: string) => boolean;
  isConfigSatisfied: (pathStr: string) => boolean;
}

interface RequirementsEvaluationRemoteContext {
  hasRemoteBin?: (bin: string) => boolean;
  hasRemoteAnyBin?: (bins: string[]) => boolean;
  remotePlatforms?: string[];
}

export function resolveMissingBins(params: {
  required: string[];
  hasLocalBin: (bin: string) => boolean;
  hasRemoteBin?: (bin: string) => boolean;
}): string[] {
  const remote = params.hasRemoteBin;
  return params.required.filter((bin) => {
    if (params.hasLocalBin(bin)) {
      return false;
    }
    if (remote?.(bin)) {
      return false;
    }
    return true;
  });
}

export function resolveMissingAnyBins(params: {
  required: string[];
  hasLocalBin: (bin: string) => boolean;
  hasRemoteAnyBin?: (bins: string[]) => boolean;
}): string[] {
  if (params.required.length === 0) {
    return [];
  }
  if (params.required.some((bin) => params.hasLocalBin(bin))) {
    return [];
  }
  if (params.hasRemoteAnyBin?.(params.required)) {
    return [];
  }
  return params.required;
}

export function resolveMissingOs(params: {
  required: string[];
  localPlatform: string;
  remotePlatforms?: string[];
}): string[] {
  if (params.required.length === 0) {
    return [];
  }
  if (params.required.includes(params.localPlatform)) {
    return [];
  }
  if (params.remotePlatforms?.some((platform) => params.required.includes(platform))) {
    return [];
  }
  return params.required;
}

export function resolveMissingEnv(params: {
  required: string[];
  isSatisfied: (envName: string) => boolean;
}): string[] {
  const missing: string[] = [];
  for (const envName of params.required) {
    if (params.isSatisfied(envName)) {
      continue;
    }
    missing.push(envName);
  }
  return missing;
}

export function buildConfigChecks(params: {
  required: string[];
  isSatisfied: (pathStr: string) => boolean;
}): RequirementConfigCheck[] {
  return params.required.map((pathStr) => {
    const satisfied = params.isSatisfied(pathStr);
    return { path: pathStr, satisfied };
  });
}

export function evaluateRequirements(
  params: RequirementsEvaluationContext &
    RequirementsEvaluationRemoteContext & {
      required: Requirements;
    },
): { missing: Requirements; eligible: boolean; configChecks: RequirementConfigCheck[] } {
  const missingBins = resolveMissingBins({
    hasLocalBin: params.hasLocalBin,
    hasRemoteBin: params.hasRemoteBin,
    required: params.required.bins,
  });
  const missingAnyBins = resolveMissingAnyBins({
    hasLocalBin: params.hasLocalBin,
    hasRemoteAnyBin: params.hasRemoteAnyBin,
    required: params.required.anyBins,
  });
  const missingOs = resolveMissingOs({
    localPlatform: params.localPlatform,
    remotePlatforms: params.remotePlatforms,
    required: params.required.os,
  });
  const missingEnv = resolveMissingEnv({
    isSatisfied: params.isEnvSatisfied,
    required: params.required.env,
  });
  const configChecks = buildConfigChecks({
    isSatisfied: params.isConfigSatisfied,
    required: params.required.config,
  });
  const missingConfig = configChecks.filter((check) => !check.satisfied).map((check) => check.path);

  const missing = params.always
    ? { anyBins: [], bins: [], config: [], env: [], os: [] }
    : {
        anyBins: missingAnyBins,
        bins: missingBins,
        config: missingConfig,
        env: missingEnv,
        os: missingOs,
      };

  const eligible =
    params.always ||
    (missing.bins.length === 0 &&
      missing.anyBins.length === 0 &&
      missing.env.length === 0 &&
      missing.config.length === 0 &&
      missing.os.length === 0);

  return { configChecks, eligible, missing };
}

export function evaluateRequirementsFromMetadata(
  params: RequirementsEvaluationContext &
    RequirementsEvaluationRemoteContext & {
      metadata?: RequirementsMetadata;
    },
): {
  required: Requirements;
  missing: Requirements;
  eligible: boolean;
  configChecks: RequirementConfigCheck[];
} {
  const required: Requirements = {
    anyBins: params.metadata?.requires?.anyBins ?? [],
    bins: params.metadata?.requires?.bins ?? [],
    config: params.metadata?.requires?.config ?? [],
    env: params.metadata?.requires?.env ?? [],
    os: params.metadata?.os ?? [],
  };

  const result = evaluateRequirements({
    always: params.always,
    hasLocalBin: params.hasLocalBin,
    hasRemoteAnyBin: params.hasRemoteAnyBin,
    hasRemoteBin: params.hasRemoteBin,
    isConfigSatisfied: params.isConfigSatisfied,
    isEnvSatisfied: params.isEnvSatisfied,
    localPlatform: params.localPlatform,
    remotePlatforms: params.remotePlatforms,
    required,
  });
  return { required, ...result };
}

export function evaluateRequirementsFromMetadataWithRemote(
  params: RequirementsEvaluationContext & {
    metadata?: RequirementsMetadata;
    remote?: RequirementRemote;
  },
): {
  required: Requirements;
  missing: Requirements;
  eligible: boolean;
  configChecks: RequirementConfigCheck[];
} {
  return evaluateRequirementsFromMetadata({
    always: params.always,
    hasLocalBin: params.hasLocalBin,
    hasRemoteAnyBin: params.remote?.hasAnyBin,
    hasRemoteBin: params.remote?.hasBin,
    isConfigSatisfied: params.isConfigSatisfied,
    isEnvSatisfied: params.isEnvSatisfied,
    localPlatform: params.localPlatform,
    metadata: params.metadata,
    remotePlatforms: params.remote?.platforms,
  });
}
