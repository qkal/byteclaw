import crypto from "node:crypto";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  type ExecAllowlistEntry,
  type ExecAsk,
  type ExecCommandSegment,
  type ExecSecurity,
  addDurableCommandApproval,
  hasDurableExecApproval,
  persistAllowAlwaysPatterns,
  recordAllowlistMatchesUse,
  resolveApprovalAuditCandidatePath,
  resolveExecApprovals,
} from "../infra/exec-approvals.js";
import type { ExecHostRequest, ExecHostResponse, ExecHostRunResult } from "../infra/exec-host.js";
import {
  describeInterpreterInlineEval,
  detectInterpreterInlineEvalArgv,
} from "../infra/exec-inline-eval.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { resolveShellWrapperTransportArgv } from "../infra/exec-wrapper-resolution.js";
import {
  inspectHostExecEnvOverrides,
  sanitizeSystemRunEnvOverrides,
} from "../infra/host-env-security.js";
import { normalizeSystemRunApprovalPlan } from "../infra/system-run-approval-binding.js";
import { resolveSystemRunCommandRequest } from "../infra/system-run-command.js";
import { logWarn } from "../logger.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { evaluateSystemRunPolicy, resolveExecApprovalDecision } from "./exec-policy.js";
import {
  applyOutputTruncation,
  evaluateSystemRunAllowlist,
  resolvePlannedAllowlistArgv,
  resolveSystemRunExecArgv,
} from "./invoke-system-run-allowlist.js";
import {
  type ApprovedCwdSnapshot,
  hardenApprovedExecutionPaths,
  resolveMutableFileOperandSnapshotSync,
  revalidateApprovedCwdSnapshot,
  revalidateApprovedMutableFileOperand,
} from "./invoke-system-run-plan.js";
import type {
  ExecEventPayload,
  ExecFinishedEventParams,
  ExecFinishedResult,
  RunResult,
  SkillBinsProvider,
  SystemRunParams,
} from "./invoke-types.js";

interface SystemRunInvokeResult {
  ok: boolean;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
}

type SystemRunDeniedReason =
  | "security=deny"
  | "approval-required"
  | "allowlist-miss"
  | "execution-plan-miss"
  | "companion-unavailable"
  | "permission:screenRecording";

interface SystemRunExecutionContext {
  sessionKey: string;
  runId: string;
  commandText: string;
  suppressNotifyOnExit: boolean;
}

type ResolvedExecApprovals = ReturnType<typeof resolveExecApprovals>;

interface SystemRunParsePhase {
  argv: string[];
  shellPayload: string | null;
  commandText: string;
  commandPreview: string | null;
  approvalPlan: import("../infra/exec-approvals.js").SystemRunApprovalPlan | null;
  agentId: string | undefined;
  sessionKey: string;
  runId: string;
  execution: SystemRunExecutionContext;
  approvalDecision: ReturnType<typeof resolveExecApprovalDecision>;
  envOverrides: Record<string, string> | undefined;
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  timeoutMs: number | undefined;
  needsScreenRecording: boolean;
  approved: boolean;
  suppressNotifyOnExit: boolean;
}

type SystemRunPolicyPhase = SystemRunParsePhase & {
  approvals: ResolvedExecApprovals;
  security: ExecSecurity;
  policy: ReturnType<typeof evaluateSystemRunPolicy>;
  durableApprovalSatisfied: boolean;
  strictInlineEval: boolean;
  inlineEvalHit: ReturnType<typeof detectInterpreterInlineEvalArgv>;
  allowlistMatches: ExecAllowlistEntry[];
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  segments: ExecCommandSegment[];
  plannedAllowlistArgv: string[] | undefined;
  isWindows: boolean;
  approvedCwdSnapshot: ApprovedCwdSnapshot | undefined;
};

const safeBinTrustedDirWarningCache = new Set<string>();
const APPROVAL_CWD_DRIFT_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval cwd changed before execution";
const APPROVAL_SCRIPT_OPERAND_BINDING_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval missing script operand binding";
const APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval script operand changed before execution";

function warnWritableTrustedDirOnce(message: string): void {
  if (safeBinTrustedDirWarningCache.has(message)) {
    return;
  }
  safeBinTrustedDirWarningCache.add(message);
  logWarn(message);
}

function normalizeDeniedReason(reason: string | null | undefined): SystemRunDeniedReason {
  switch (reason) {
    case "security=deny":
    case "approval-required":
    case "allowlist-miss":
    case "execution-plan-miss":
    case "companion-unavailable":
    case "permission:screenRecording": {
      return reason;
    }
    default: {
      return "approval-required";
    }
  }
}

export interface HandleSystemRunInvokeOptions {
  client: GatewayClient;
  params: SystemRunParams;
  skillBins: SkillBinsProvider;
  execHostEnforced: boolean;
  execHostFallbackAllowed: boolean;
  resolveExecSecurity: (value?: string) => ExecSecurity;
  resolveExecAsk: (value?: string) => ExecAsk;
  isCmdExeInvocation: (argv: string[]) => boolean;
  sanitizeEnv: (overrides?: Record<string, string> | null) => Record<string, string> | undefined;
  runCommand: (
    argv: string[],
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    timeoutMs: number | undefined,
  ) => Promise<RunResult>;
  runViaMacAppExecHost: (params: {
    approvals: ReturnType<typeof resolveExecApprovals>;
    request: ExecHostRequest;
  }) => Promise<ExecHostResponse | null>;
  sendNodeEvent: (client: GatewayClient, event: string, payload: unknown) => Promise<void>;
  buildExecEventPayload: (payload: ExecEventPayload) => ExecEventPayload;
  sendInvokeResult: (result: SystemRunInvokeResult) => Promise<void>;
  sendExecFinishedEvent: (params: ExecFinishedEventParams) => Promise<void>;
  preferMacAppExecHost: boolean;
}

async function sendSystemRunDenied(
  opts: Pick<
    HandleSystemRunInvokeOptions,
    "client" | "sendNodeEvent" | "buildExecEventPayload" | "sendInvokeResult"
  >,
  execution: SystemRunExecutionContext,
  params: {
    reason: SystemRunDeniedReason;
    message: string;
  },
) {
  await opts.sendNodeEvent(
    opts.client,
    "exec.denied",
    opts.buildExecEventPayload({
      command: execution.commandText,
      host: "node",
      reason: params.reason,
      runId: execution.runId,
      sessionKey: execution.sessionKey,
      suppressNotifyOnExit: execution.suppressNotifyOnExit,
    }),
  );
  await opts.sendInvokeResult({
    error: { code: "UNAVAILABLE", message: params.message },
    ok: false,
  });
}

async function sendSystemRunCompleted(
  opts: Pick<HandleSystemRunInvokeOptions, "sendExecFinishedEvent" | "sendInvokeResult">,
  execution: SystemRunExecutionContext,
  result: ExecFinishedResult,
  payloadJSON: string,
) {
  await opts.sendExecFinishedEvent({
    commandText: execution.commandText,
    result,
    runId: execution.runId,
    sessionKey: execution.sessionKey,
    suppressNotifyOnExit: execution.suppressNotifyOnExit,
  });
  await opts.sendInvokeResult({
    ok: true,
    payloadJSON,
  });
}

export { formatSystemRunAllowlistMissMessage } from "./exec-policy.js";
export { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";

async function parseSystemRunPhase(
  opts: HandleSystemRunInvokeOptions,
): Promise<SystemRunParsePhase | null> {
  const command = resolveSystemRunCommandRequest({
    command: opts.params.command,
    rawCommand: opts.params.rawCommand,
  });
  if (!command.ok) {
    await opts.sendInvokeResult({
      error: { code: "INVALID_REQUEST", message: command.message },
      ok: false,
    });
    return null;
  }
  if (command.argv.length === 0) {
    await opts.sendInvokeResult({
      error: { code: "INVALID_REQUEST", message: "command required" },
      ok: false,
    });
    return null;
  }

  const { shellPayload } = command;
  const { commandText } = command;
  const approvalPlan =
    opts.params.systemRunPlan === undefined
      ? null
      : normalizeSystemRunApprovalPlan(opts.params.systemRunPlan);
  if (opts.params.systemRunPlan !== undefined && !approvalPlan) {
    await opts.sendInvokeResult({
      error: { code: "INVALID_REQUEST", message: "systemRunPlan invalid" },
      ok: false,
    });
    return null;
  }
  const agentId = normalizeOptionalString(opts.params.agentId);
  const sessionKey = normalizeOptionalString(opts.params.sessionKey) ?? "node";
  const runId = normalizeOptionalString(opts.params.runId) ?? crypto.randomUUID();
  const suppressNotifyOnExit = opts.params.suppressNotifyOnExit === true;
  const envOverrideDiagnostics = inspectHostExecEnvOverrides({
    blockPathOverrides: true,
    overrides: opts.params.env ?? undefined,
  });
  if (
    envOverrideDiagnostics.rejectedOverrideBlockedKeys.length > 0 ||
    envOverrideDiagnostics.rejectedOverrideInvalidKeys.length > 0
  ) {
    const details: string[] = [];
    if (envOverrideDiagnostics.rejectedOverrideBlockedKeys.length > 0) {
      details.push(
        `blocked override keys: ${envOverrideDiagnostics.rejectedOverrideBlockedKeys.join(", ")}`,
      );
    }
    if (envOverrideDiagnostics.rejectedOverrideInvalidKeys.length > 0) {
      details.push(
        `invalid non-portable override keys: ${envOverrideDiagnostics.rejectedOverrideInvalidKeys.join(", ")}`,
      );
    }
    await opts.sendInvokeResult({
      error: {
        code: "INVALID_REQUEST",
        message: `SYSTEM_RUN_DENIED: environment override rejected (${details.join("; ")})`,
      },
      ok: false,
    });
    return null;
  }
  const envOverrides = sanitizeSystemRunEnvOverrides({
    overrides: opts.params.env ?? undefined,
    shellWrapper: shellPayload !== null,
  });
  return {
    agentId,
    approvalDecision: resolveExecApprovalDecision(opts.params.approvalDecision),
    approvalPlan,
    approved: opts.params.approved === true,
    argv: command.argv,
    commandPreview: command.previewText,
    commandText,
    cwd: normalizeOptionalString(opts.params.cwd),
    env: opts.sanitizeEnv(envOverrides),
    envOverrides,
    execution: { commandText, runId, sessionKey, suppressNotifyOnExit },
    needsScreenRecording: opts.params.needsScreenRecording === true,
    runId,
    sessionKey,
    shellPayload,
    suppressNotifyOnExit,
    timeoutMs: opts.params.timeoutMs ?? undefined,
  };
}

async function evaluateSystemRunPolicyPhase(
  opts: HandleSystemRunInvokeOptions,
  parsed: SystemRunParsePhase,
): Promise<SystemRunPolicyPhase | null> {
  const cfg = loadConfig();
  const agentExec = parsed.agentId
    ? resolveAgentConfig(cfg, parsed.agentId)?.tools?.exec
    : undefined;
  const configuredSecurity = opts.resolveExecSecurity(
    agentExec?.security ?? cfg.tools?.exec?.security,
  );
  const configuredAsk = opts.resolveExecAsk(agentExec?.ask ?? cfg.tools?.exec?.ask);
  const approvals = resolveExecApprovals(parsed.agentId, {
    ask: configuredAsk,
    security: configuredSecurity,
  });
  const { security } = approvals.agent;
  const { ask } = approvals.agent;
  const { autoAllowSkills } = approvals.agent;
  const { safeBins, safeBinProfiles, trustedSafeBinDirs } = resolveExecSafeBinRuntimePolicy({
    global: cfg.tools?.exec,
    local: agentExec,
    onWarning: warnWritableTrustedDirOnce,
  });
  const bins = autoAllowSkills ? await opts.skillBins.current() : [];
  let { analysisOk, allowlistMatches, allowlistSatisfied, segments, segmentAllowlistEntries } =
    evaluateSystemRunAllowlist({
      approvals,
      argv: parsed.argv,
      autoAllowSkills,
      cwd: parsed.cwd,
      env: parsed.env,
      safeBinProfiles,
      safeBins,
      security,
      shellCommand: parsed.shellPayload,
      skillBins: bins,
      trustedSafeBinDirs,
    });
  const strictInlineEval =
    agentExec?.strictInlineEval === true || cfg.tools?.exec?.strictInlineEval === true;
  const inlineEvalHit = strictInlineEval
    ? (segments
        .map((segment) =>
          detectInterpreterInlineEvalArgv(segment.resolution?.effectiveArgv ?? segment.argv),
        )
        .find((entry) => entry !== null) ?? null)
    : null;
  const isWindows = process.platform === "win32";
  // Detect Windows wrapper transport from the same shell-wrapper view used to
  // Derive the inner payload. That keeps `cmd.exe /c` approval-gated even when
  // Dispatch carriers like `env FOO=bar ...` wrap the shell invocation.
  const cmdDetectionArgv = resolveShellWrapperTransportArgv(parsed.argv) ?? parsed.argv;
  const cmdInvocation = opts.isCmdExeInvocation(cmdDetectionArgv);
  const durableApprovalSatisfied = hasDurableExecApproval({
    allowlist: approvals.allowlist,
    analysisOk,
    commandText: parsed.commandText,
    segmentAllowlistEntries,
  });
  const inlineEvalExecutableTrusted =
    inlineEvalHit !== null &&
    segmentAllowlistEntries.some((entry) => entry?.source === "allow-always");
  const policy = evaluateSystemRunPolicy({
    allowlistSatisfied,
    analysisOk,
    approvalDecision: parsed.approvalDecision,
    approved: parsed.approved,
    ask,
    cmdInvocation,
    durableApprovalSatisfied: durableApprovalSatisfied || inlineEvalExecutableTrusted,
    isWindows,
    security,
    shellWrapperInvocation: parsed.shellPayload !== null,
  });
  ({ analysisOk } = policy);
  ({ allowlistSatisfied } = policy);
  const strictInlineEvalRequiresApproval =
    inlineEvalHit !== null &&
    !policy.approvedByAsk &&
    (policy.allowed ? true : policy.eventReason !== "security=deny");
  if (strictInlineEvalRequiresApproval) {
    await sendSystemRunDenied(opts, parsed.execution, {
      message:
        `SYSTEM_RUN_DENIED: approval required (` +
        `${describeInterpreterInlineEval(inlineEvalHit)} requires explicit approval in strictInlineEval mode)`,
      reason: "approval-required",
    });
    return null;
  }

  if (!policy.allowed) {
    await sendSystemRunDenied(opts, parsed.execution, {
      message: policy.errorMessage,
      reason: policy.eventReason,
    });
    return null;
  }

  // Fail closed if policy/runtime drift re-allows Windows shell wrappers.
  if (policy.shellWrapperBlocked && !policy.approvedByAsk && !durableApprovalSatisfied) {
    await sendSystemRunDenied(opts, parsed.execution, {
      message: "SYSTEM_RUN_DENIED: approval required",
      reason: "approval-required",
    });
    return null;
  }

  const hardenedPaths = hardenApprovedExecutionPaths({
    approvedByAsk: policy.approvedByAsk,
    argv: parsed.argv,
    cwd: parsed.cwd,
    shellCommand: parsed.shellPayload,
  });
  if (!hardenedPaths.ok) {
    await sendSystemRunDenied(opts, parsed.execution, {
      message: hardenedPaths.message,
      reason: "approval-required",
    });
    return null;
  }
  const approvedCwdSnapshot = policy.approvedByAsk ? hardenedPaths.approvedCwdSnapshot : undefined;
  if (policy.approvedByAsk && hardenedPaths.cwd && !approvedCwdSnapshot) {
    await sendSystemRunDenied(opts, parsed.execution, {
      message: APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
      reason: "approval-required",
    });
    return null;
  }

  const plannedAllowlistArgv = resolvePlannedAllowlistArgv({
    policy,
    security,
    segments,
    shellCommand: parsed.shellPayload,
  });
  if (plannedAllowlistArgv === null) {
    await sendSystemRunDenied(opts, parsed.execution, {
      message: "SYSTEM_RUN_DENIED: execution plan mismatch",
      reason: "execution-plan-miss",
    });
    return null;
  }
  return {
    ...parsed,
    allowlistMatches,
    allowlistSatisfied,
    analysisOk,
    approvals,
    approvedCwdSnapshot,
    argv: hardenedPaths.argv,
    cwd: hardenedPaths.cwd,
    durableApprovalSatisfied,
    inlineEvalHit,
    isWindows,
    plannedAllowlistArgv: plannedAllowlistArgv ?? undefined,
    policy,
    security,
    segments,
    strictInlineEval,
  };
}

async function executeSystemRunPhase(
  opts: HandleSystemRunInvokeOptions,
  phase: SystemRunPolicyPhase,
): Promise<void> {
  if (
    phase.approvedCwdSnapshot &&
    !revalidateApprovedCwdSnapshot({ snapshot: phase.approvedCwdSnapshot })
  ) {
    logWarn(`security: system.run approval cwd drift blocked (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      message: APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
      reason: "approval-required",
    });
    return;
  }
  const expectedMutableFileOperand = phase.approvalPlan
    ? resolveMutableFileOperandSnapshotSync({
        argv: phase.argv,
        cwd: phase.cwd,
        shellCommand: phase.shellPayload,
      })
    : null;
  if (expectedMutableFileOperand && !expectedMutableFileOperand.ok) {
    logWarn(`security: system.run approval script binding blocked (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      message: expectedMutableFileOperand.message,
      reason: "approval-required",
    });
    return;
  }
  if (expectedMutableFileOperand?.snapshot && !phase.approvalPlan?.mutableFileOperand) {
    logWarn(`security: system.run approval script binding missing (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      message: APPROVAL_SCRIPT_OPERAND_BINDING_DENIED_MESSAGE,
      reason: "approval-required",
    });
    return;
  }
  if (
    phase.approvalPlan?.mutableFileOperand &&
    !revalidateApprovedMutableFileOperand({
      argv: phase.argv,
      cwd: phase.cwd,
      snapshot: phase.approvalPlan.mutableFileOperand,
    })
  ) {
    logWarn(`security: system.run approval script drift blocked (runId=${phase.runId})`);
    await sendSystemRunDenied(opts, phase.execution, {
      message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      reason: "approval-required",
    });
    return;
  }

  const useMacAppExec = opts.preferMacAppExecHost;
  if (useMacAppExec) {
    const execRequest: ExecHostRequest = {
      command: phase.plannedAllowlistArgv ?? phase.argv,
      // Forward canonical display text so companion approval/prompt surfaces bind to
      // The exact command context already validated on the node-host.
      rawCommand: phase.commandText || null,
      cwd: phase.cwd ?? null,
      env: phase.envOverrides ?? null,
      timeoutMs: phase.timeoutMs ?? null,
      needsScreenRecording: phase.needsScreenRecording,
      agentId: phase.agentId ?? null,
      sessionKey: phase.sessionKey ?? null,
      approvalDecision: phase.approvalDecision,
    };
    const response = await opts.runViaMacAppExecHost({
      approvals: phase.approvals,
      request: execRequest,
    });
    if (!response) {
      if (opts.execHostEnforced || !opts.execHostFallbackAllowed) {
        await sendSystemRunDenied(opts, phase.execution, {
          message: "COMPANION_APP_UNAVAILABLE: macOS app exec host unreachable",
          reason: "companion-unavailable",
        });
        return;
      }
    } else if (!response.ok) {
      await sendSystemRunDenied(opts, phase.execution, {
        message: response.error.message,
        reason: normalizeDeniedReason(response.error.reason),
      });
      return;
    } else {
      const result: ExecHostRunResult = response.payload;
      await sendSystemRunCompleted(opts, phase.execution, result, JSON.stringify(result));
      return;
    }
  }

  if (phase.policy.approvalDecision === "allow-always" && phase.inlineEvalHit === null) {
    const patterns = phase.policy.analysisOk
      ? persistAllowAlwaysPatterns({
          agentId: phase.agentId,
          approvals: phase.approvals.file,
          cwd: phase.cwd,
          env: phase.env,
          platform: process.platform,
          segments: phase.segments,
          strictInlineEval: phase.strictInlineEval,
        })
      : [];
    if (patterns.length === 0) {
      addDurableCommandApproval(phase.approvals.file, phase.agentId, phase.commandText);
    }
  }

  recordAllowlistMatchesUse({
    agentId: phase.agentId,
    approvals: phase.approvals.file,
    command: phase.commandText,
    matches: phase.allowlistMatches,
    resolvedPath: resolveApprovalAuditCandidatePath(
      phase.segments[0]?.resolution ?? null,
      phase.cwd,
    ),
  });

  if (phase.needsScreenRecording) {
    await sendSystemRunDenied(opts, phase.execution, {
      message: "PERMISSION_MISSING: screenRecording",
      reason: "permission:screenRecording",
    });
    return;
  }

  const execArgv = resolveSystemRunExecArgv({
    argv: phase.argv,
    isWindows: phase.isWindows,
    plannedAllowlistArgv: phase.plannedAllowlistArgv,
    policy: phase.policy,
    security: phase.security,
    segments: phase.segments,
    shellCommand: phase.shellPayload,
  });

  const result = await opts.runCommand(execArgv, phase.cwd, phase.env, phase.timeoutMs);
  applyOutputTruncation(result);
  await sendSystemRunCompleted(
    opts,
    phase.execution,
    result,
    JSON.stringify({
      error: result.error ?? null,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      success: result.success,
      timedOut: result.timedOut,
    }),
  );
}

export async function handleSystemRunInvoke(opts: HandleSystemRunInvokeOptions): Promise<void> {
  const parsed = await parseSystemRunPhase(opts);
  if (!parsed) {
    return;
  }
  const policyPhase = await evaluateSystemRunPolicyPhase(opts, parsed);
  if (!policyPhase) {
    return;
  }
  await executeSystemRunPhase(opts, policyPhase);
}
