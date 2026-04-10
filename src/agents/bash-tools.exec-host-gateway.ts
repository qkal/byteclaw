import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type ExecAsk,
  type ExecSecurity,
  addDurableCommandApproval,
  buildEnforcedShellCommand,
  evaluateShellAllowlist,
  hasDurableExecApproval,
  persistAllowAlwaysPatterns,
  recordAllowlistMatchesUse,
  requiresExecApproval,
  resolveApprovalAuditCandidatePath,
  resolveExecApprovalAllowedDecisions,
} from "../infra/exec-approvals.js";
import {
  describeInterpreterInlineEval,
  detectInterpreterInlineEvalArgv,
} from "../infra/exec-inline-eval.js";
import type { SafeBinProfile } from "../infra/exec-safe-bin-policy.js";
import { markBackgrounded, tail } from "./bash-process-registry.js";
import {
  buildExecApprovalRequesterContext,
  buildExecApprovalTurnSourceContext,
  registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import {
  buildDefaultExecApprovalRequestArgs,
  buildExecApprovalFollowupTarget,
  buildExecApprovalPendingToolResult,
  buildHeadlessExecApprovalDeniedMessage,
  createAndRegisterDefaultExecApprovalRequest,
  createExecApprovalDecisionState,
  enforceStrictInlineEvalApprovalBoundary,
  resolveApprovalDecisionOrUndefined,
  resolveExecHostApprovalContext,
  sendExecApprovalFollowupResult,
  shouldResolveExecApprovalUnavailableInline,
} from "./bash-tools.exec-host-shared.js";
import {
  DEFAULT_NOTIFY_TAIL_CHARS,
  createApprovalSlug,
  normalizeNotifyOutput,
  runExecProcess,
} from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";

export interface ProcessGatewayAllowlistParams {
  command: string;
  workdir: string;
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  pty: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  security: ExecSecurity;
  ask: ExecAsk;
  safeBins: Set<string>;
  safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
  strictInlineEval?: boolean;
  trigger?: string;
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  scopeKey?: string;
  warnings: string[];
  notifySessionKey?: string;
  approvalRunningNoticeMs: number;
  maxOutput: number;
  pendingMaxOutput: number;
  trustedSafeBinDirs?: ReadonlySet<string>;
}

export interface ProcessGatewayAllowlistResult {
  execCommandOverride?: string;
  allowWithoutEnforcedCommand?: boolean;
  pendingResult?: AgentToolResult<ExecToolDetails>;
}

function hasGatewayAllowlistMiss(params: {
  hostSecurity: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied: boolean;
}): boolean {
  return (
    params.hostSecurity === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied) &&
    !params.durableApprovalSatisfied
  );
}

export async function processGatewayAllowlist(
  params: ProcessGatewayAllowlistParams,
): Promise<ProcessGatewayAllowlistResult> {
  const { approvals, hostSecurity, hostAsk, askFallback } = resolveExecHostApprovalContext({
    agentId: params.agentId,
    ask: params.ask,
    host: "gateway",
    security: params.security,
  });
  const allowlistEval = evaluateShellAllowlist({
    allowlist: approvals.allowlist,
    command: params.command,
    cwd: params.workdir,
    env: params.env,
    platform: process.platform,
    safeBinProfiles: params.safeBinProfiles,
    safeBins: params.safeBins,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
  });
  const {allowlistMatches} = allowlistEval;
  const {analysisOk} = allowlistEval;
  const allowlistSatisfied =
    hostSecurity === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
  const durableApprovalSatisfied = hasDurableExecApproval({
    allowlist: approvals.allowlist,
    analysisOk,
    commandText: params.command,
    segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
  });
  const inlineEvalHit =
    params.strictInlineEval === true
      ? (allowlistEval.segments
          .map((segment) =>
            detectInterpreterInlineEvalArgv(segment.resolution?.effectiveArgv ?? segment.argv),
          )
          .find((entry) => entry !== null) ?? null)
      : null;
  if (inlineEvalHit) {
    params.warnings.push(
      `Warning: strict inline-eval mode requires explicit approval for ${describeInterpreterInlineEval(
        inlineEvalHit,
      )}.`,
    );
  }
  let enforcedCommand: string | undefined;
  let allowlistPlanUnavailableReason: string | null = null;
  if (hostSecurity === "allowlist" && analysisOk && allowlistSatisfied) {
    const enforced = buildEnforcedShellCommand({
      command: params.command,
      platform: process.platform,
      segments: allowlistEval.segments,
    });
    if (!enforced.ok || !enforced.command) {
      allowlistPlanUnavailableReason = enforced.reason ?? "unsupported platform";
    } else {
      enforcedCommand = enforced.command;
    }
  }
  const recordMatchedAllowlistUse = (resolvedPath?: string) =>
    recordAllowlistMatchesUse({
      agentId: params.agentId,
      approvals: approvals.file,
      command: params.command,
      matches: allowlistMatches,
      resolvedPath,
    });
  const hasHeredocSegment = allowlistEval.segments.some((segment) =>
    segment.argv.some((token) => token.startsWith("<<")),
  );
  const requiresHeredocApproval =
    hostSecurity === "allowlist" && analysisOk && allowlistSatisfied && hasHeredocSegment;
  const requiresInlineEvalApproval = inlineEvalHit !== null;
  const requiresAllowlistPlanApproval =
    hostSecurity === "allowlist" &&
    analysisOk &&
    allowlistSatisfied &&
    !enforcedCommand &&
    allowlistPlanUnavailableReason !== null;
  const requiresAsk =
    requiresExecApproval({
      allowlistSatisfied,
      analysisOk,
      ask: hostAsk,
      durableApprovalSatisfied,
      security: hostSecurity,
    }) ||
    requiresAllowlistPlanApproval ||
    requiresHeredocApproval ||
    requiresInlineEvalApproval;
  if (requiresHeredocApproval) {
    params.warnings.push(
      "Warning: heredoc execution requires explicit approval in allowlist mode.",
    );
  }
  if (requiresAllowlistPlanApproval) {
    params.warnings.push(
      `Warning: allowlist auto-execution is unavailable on ${process.platform}; explicit approval is required.`,
    );
  }

  if (requiresAsk) {
    const requestArgs = buildDefaultExecApprovalRequestArgs({
      approvalRunningNoticeMs: params.approvalRunningNoticeMs,
      createApprovalSlug,
      turnSourceAccountId: params.turnSourceAccountId,
      turnSourceChannel: params.turnSourceChannel,
      warnings: params.warnings,
    });
    const registerGatewayApproval = async (approvalId: string) =>
      await registerExecApprovalRequestForHostOrThrow({
        approvalId,
        command: params.command,
        env: params.requestedEnv,
        workdir: params.workdir,
        host: "gateway",
        security: hostSecurity,
        ask: hostAsk,
        ...buildExecApprovalRequesterContext({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        }),
        resolvedPath: resolveApprovalAuditCandidatePath(
          allowlistEval.segments[0]?.resolution ?? null,
          params.workdir,
        ),
        ...buildExecApprovalTurnSourceContext(params),
      });
    const {
      approvalId,
      approvalSlug,
      warningText,
      expiresAtMs,
      preResolvedDecision,
      initiatingSurface,
      sentApproverDms,
      unavailableReason,
    } = await createAndRegisterDefaultExecApprovalRequest({
      ...requestArgs,
      register: registerGatewayApproval,
    });
    if (
      shouldResolveExecApprovalUnavailableInline({
        preResolvedDecision,
        trigger: params.trigger,
        unavailableReason,
      })
    ) {
      const { baseDecision, approvedByAsk, deniedReason } = createExecApprovalDecisionState({
        askFallback,
        decision: preResolvedDecision,
      });
      const strictInlineEvalDecision = enforceStrictInlineEvalApprovalBoundary({
        approvedByAsk,
        baseDecision,
        deniedReason,
        requiresInlineEvalApproval,
      });

      if (strictInlineEvalDecision.deniedReason || !strictInlineEvalDecision.approvedByAsk) {
        throw new Error(
          buildHeadlessExecApprovalDeniedMessage({
            ask: hostAsk,
            askFallback,
            host: "gateway",
            security: hostSecurity,
            trigger: params.trigger,
          }),
        );
      }

      recordMatchedAllowlistUse(
        resolveApprovalAuditCandidatePath(
          allowlistEval.segments[0]?.resolution ?? null,
          params.workdir,
        ),
      );
      return {
        allowWithoutEnforcedCommand: enforcedCommand === undefined,
        execCommandOverride: enforcedCommand,
      };
    }
    const resolvedPath = resolveApprovalAuditCandidatePath(
      allowlistEval.segments[0]?.resolution ?? null,
      params.workdir,
    );
    const effectiveTimeout =
      typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec;
    const followupTarget = buildExecApprovalFollowupTarget({
      approvalId,
      sessionKey: params.notifySessionKey ?? params.sessionKey,
      turnSourceAccountId: params.turnSourceAccountId,
      turnSourceChannel: params.turnSourceChannel,
      turnSourceThreadId: params.turnSourceThreadId,
      turnSourceTo: params.turnSourceTo,
    });

    void (async () => {
      const decision = await resolveApprovalDecisionOrUndefined({
        approvalId,
        onFailure: () =>
          void sendExecApprovalFollowupResult(
            followupTarget,
            `Exec denied (gateway id=${approvalId}, approval-request-failed): ${params.command}`,
          ),
        preResolvedDecision,
      });
      if (decision === undefined) {
        return;
      }

      const {
        baseDecision,
        approvedByAsk: initialApprovedByAsk,
        deniedReason: initialDeniedReason,
      } = createExecApprovalDecisionState({
        askFallback,
        decision,
      });
      let approvedByAsk = initialApprovedByAsk;
      let deniedReason = initialDeniedReason;

      if (baseDecision.timedOut && askFallback === "allowlist") {
        if (!analysisOk || !allowlistSatisfied) {
          deniedReason = "approval-timeout (allowlist-miss)";
        } else {
          approvedByAsk = true;
        }
      } else if (decision === "allow-once") {
        approvedByAsk = true;
      } else if (decision === "allow-always") {
        approvedByAsk = true;
        if (!requiresInlineEvalApproval) {
          const patterns = persistAllowAlwaysPatterns({
            agentId: params.agentId,
            approvals: approvals.file,
            cwd: params.workdir,
            env: params.env,
            platform: process.platform,
            segments: allowlistEval.segments,
            strictInlineEval: params.strictInlineEval === true,
          });
          if (patterns.length === 0) {
            addDurableCommandApproval(approvals.file, params.agentId, params.command);
          }
        }
      }

      ({ approvedByAsk, deniedReason } = enforceStrictInlineEvalApprovalBoundary({
        approvedByAsk,
        baseDecision,
        deniedReason,
        requiresInlineEvalApproval,
      }));

      if (
        !approvedByAsk &&
        hasGatewayAllowlistMiss({
          allowlistSatisfied,
          analysisOk,
          durableApprovalSatisfied,
          hostSecurity,
        })
      ) {
        deniedReason = deniedReason ?? "allowlist-miss";
      }

      if (deniedReason) {
        await sendExecApprovalFollowupResult(
          followupTarget,
          `Exec denied (gateway id=${approvalId}, ${deniedReason}): ${params.command}`,
        );
        return;
      }

      recordMatchedAllowlistUse(resolvedPath ?? undefined);

      let run: Awaited<ReturnType<typeof runExecProcess>> | null = null;
      try {
        run = await runExecProcess({
          command: params.command,
          containerWorkdir: null,
          env: params.env,
          execCommand: enforcedCommand,
          maxOutput: params.maxOutput,
          notifyOnExit: false,
          notifyOnExitEmptySuccess: false,
          pendingMaxOutput: params.pendingMaxOutput,
          sandbox: undefined,
          scopeKey: params.scopeKey,
          sessionKey: params.notifySessionKey ?? params.sessionKey,
          timeoutSec: effectiveTimeout,
          usePty: params.pty,
          warnings: params.warnings,
          workdir: params.workdir,
        });
      } catch {
        await sendExecApprovalFollowupResult(
          followupTarget,
          `Exec denied (gateway id=${approvalId}, spawn-failed): ${params.command}`,
        );
        return;
      }

      markBackgrounded(run.session);

      const outcome = await run.promise;
      const output = normalizeNotifyOutput(
        tail(outcome.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
      );
      const exitLabel = outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
      const summary = output
        ? `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})\n${output}`
        : `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})`;
      await sendExecApprovalFollowupResult(followupTarget, summary);
    })();

    return {
      pendingResult: buildExecApprovalPendingToolResult({
        allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: hostAsk }),
        approvalId,
        approvalSlug,
        command: params.command,
        cwd: params.workdir,
        expiresAtMs,
        host: "gateway",
        initiatingSurface,
        sentApproverDms,
        unavailableReason,
        warningText,
      }),
    };
  }

  if (
    hasGatewayAllowlistMiss({
      allowlistSatisfied,
      analysisOk,
      durableApprovalSatisfied,
      hostSecurity,
    })
  ) {
    throw new Error("exec denied: allowlist miss");
  }

  recordMatchedAllowlistUse(
    resolveApprovalAuditCandidatePath(
      allowlistEval.segments[0]?.resolution ?? null,
      params.workdir,
    ),
  );

  return { execCommandOverride: enforcedCommand };
}
