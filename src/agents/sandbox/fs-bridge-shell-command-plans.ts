import type { AnchoredSandboxEntry, PathSafetyCheck } from "./fs-bridge-path-safety.js";
import type { SandboxResolvedFsPath } from "./fs-paths.js";

export interface SandboxFsCommandPlan {
  checks: PathSafetyCheck[];
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  recheckBeforeCommand?: boolean;
  allowFailure?: boolean;
}

export function buildStatPlan(
  target: SandboxResolvedFsPath,
  anchoredTarget: AnchoredSandboxEntry,
): SandboxFsCommandPlan {
  return {
    allowFailure: true,
    args: [anchoredTarget.canonicalParentPath, anchoredTarget.basename],
    checks: [{ options: { action: "stat files" }, target }],
    script: 'set -eu\ncd -- "$1"\nstat -c "%F|%s|%Y" -- "$2"',
  };
}
