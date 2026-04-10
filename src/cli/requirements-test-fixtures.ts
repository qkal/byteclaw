export function createEmptyRequirements() {
  return {
    anyBins: [],
    bins: [],
    config: [],
    env: [],
    os: [],
  };
}

export function createEmptyInstallChecks() {
  return {
    configChecks: [],
    install: [],
    missing: createEmptyRequirements(),
    requirements: createEmptyRequirements(),
  };
}
