import type {
  resolveExecApprovals} from "../infra/exec-approvals.js";
import {
  type ExecAllowlistEntry,
  type ExecCommandSegment,
  type ExecSecurity,
  type SkillBinTrustEntry,
  analyzeArgvCommand,
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  resolvePlannedSegmentArgv,
} from "../infra/exec-approvals.js";
import type { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import type { RunResult } from "./invoke-types.js";

export interface SystemRunAllowlistAnalysis {
  analysisOk: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  allowlistSatisfied: boolean;
  segments: ExecCommandSegment[];
  segmentAllowlistEntries: (ExecAllowlistEntry | null)[];
}

export function evaluateSystemRunAllowlist(params: {
  shellCommand: string | null;
  argv: string[];
  approvals: ReturnType<typeof resolveExecApprovals>;
  security: ExecSecurity;
  safeBins: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBins"];
  safeBinProfiles: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBinProfiles"];
  trustedSafeBinDirs: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["trustedSafeBinDirs"];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  skillBins: SkillBinTrustEntry[];
  autoAllowSkills: boolean;
}): SystemRunAllowlistAnalysis {
  if (params.shellCommand) {
    const allowlistEval = evaluateShellAllowlist({
      allowlist: params.approvals.allowlist,
      autoAllowSkills: params.autoAllowSkills,
      command: params.shellCommand,
      cwd: params.cwd,
      env: params.env,
      platform: process.platform,
      safeBinProfiles: params.safeBinProfiles,
      safeBins: params.safeBins,
      skillBins: params.skillBins,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
    });
    return {
      allowlistMatches: allowlistEval.allowlistMatches,
      allowlistSatisfied:
        params.security === "allowlist" && allowlistEval.analysisOk
          ? allowlistEval.allowlistSatisfied
          : false,
      analysisOk: allowlistEval.analysisOk,
      segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
      segments: allowlistEval.segments,
    };
  }

  const analysis = analyzeArgvCommand({ argv: params.argv, cwd: params.cwd, env: params.env });
  const allowlistEval = evaluateExecAllowlist({
    allowlist: params.approvals.allowlist,
    analysis,
    autoAllowSkills: params.autoAllowSkills,
    cwd: params.cwd,
    safeBinProfiles: params.safeBinProfiles,
    safeBins: params.safeBins,
    skillBins: params.skillBins,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
  });
  return {
    allowlistMatches: allowlistEval.allowlistMatches,
    allowlistSatisfied:
      params.security === "allowlist" && analysis.ok ? allowlistEval.allowlistSatisfied : false,
    analysisOk: analysis.ok,
    segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
    segments: analysis.segments,
  };
}

export function resolvePlannedAllowlistArgv(params: {
  security: ExecSecurity;
  shellCommand: string | null;
  policy: {
    approvedByAsk: boolean;
    analysisOk: boolean;
    allowlistSatisfied: boolean;
  };
  segments: ExecCommandSegment[];
}): string[] | undefined | null {
  if (
    params.security !== "allowlist" ||
    params.policy.approvedByAsk ||
    params.shellCommand ||
    !params.policy.analysisOk ||
    !params.policy.allowlistSatisfied ||
    params.segments.length !== 1
  ) {
    return undefined;
  }
  const plannedAllowlistArgv = resolvePlannedSegmentArgv(params.segments[0]);
  return plannedAllowlistArgv && plannedAllowlistArgv.length > 0 ? plannedAllowlistArgv : null;
}

export function resolveSystemRunExecArgv(params: {
  plannedAllowlistArgv: string[] | undefined;
  argv: string[];
  security: ExecSecurity;
  isWindows: boolean;
  policy: {
    approvedByAsk: boolean;
    analysisOk: boolean;
    allowlistSatisfied: boolean;
  };
  shellCommand: string | null;
  segments: ExecCommandSegment[];
}): string[] {
  let execArgv = params.plannedAllowlistArgv ?? params.argv;
  if (
    params.security === "allowlist" &&
    params.isWindows &&
    !params.policy.approvedByAsk &&
    params.shellCommand &&
    params.policy.analysisOk &&
    params.policy.allowlistSatisfied &&
    params.segments.length === 1 &&
    params.segments[0]?.argv.length > 0
  ) {
    execArgv = params.segments[0].argv;
  }
  return execArgv;
}

export function applyOutputTruncation(result: RunResult): void {
  if (!result.truncated) {
    return;
  }
  const suffix = "... (truncated)";
  if (result.stderr.trim().length > 0) {
    result.stderr = `${result.stderr}\n${suffix}`;
  } else {
    result.stdout = `${result.stdout}\n${suffix}`;
  }
}
