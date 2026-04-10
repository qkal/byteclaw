import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  evaluateShellAllowlist,
  hasDurableExecApproval,
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import {
  describeInterpreterInlineEval,
  detectInterpreterInlineEvalArgv,
} from "../infra/exec-inline-eval.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { parsePreparedSystemRunPayload } from "../infra/system-run-approval-context.js";
import {
  buildExecApprovalRequesterContext,
  buildExecApprovalTurnSourceContext,
  registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import * as execHostShared from "./bash-tools.exec-host-shared.js";
import {
  DEFAULT_NOTIFY_TAIL_CHARS,
  createApprovalSlug,
  normalizeNotifyOutput,
} from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { callGatewayTool } from "./tools/gateway.js";
import { listNodes, resolveNodeIdFromList } from "./tools/nodes-utils.js";

export interface ExecuteNodeHostCommandParams {
  command: string;
  workdir: string | undefined;
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  requestedNode?: string;
  boundNode?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  trigger?: string;
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  strictInlineEval?: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  approvalRunningNoticeMs: number;
  warnings: string[];
  notifySessionKey?: string;
  trustedSafeBinDirs?: ReadonlySet<string>;
}

export async function executeNodeHostCommand(
  params: ExecuteNodeHostCommandParams,
): Promise<AgentToolResult<ExecToolDetails>> {
  const { hostSecurity, hostAsk, askFallback } = execHostShared.resolveExecHostApprovalContext({
    agentId: params.agentId,
    ask: params.ask,
    host: "node",
    security: params.security,
  });
  if (params.boundNode && params.requestedNode && params.boundNode !== params.requestedNode) {
    throw new Error(`exec node not allowed (bound to ${params.boundNode})`);
  }
  const nodeQuery = params.boundNode || params.requestedNode;
  const nodes = await listNodes({});
  if (nodes.length === 0) {
    throw new Error(
      "exec host=node requires a paired node (none available). This requires a companion app or node host.",
    );
  }
  let nodeId: string;
  try {
    nodeId = resolveNodeIdFromList(nodes, nodeQuery, !nodeQuery);
  } catch (error) {
    if (!nodeQuery && String(error).includes("node required")) {
      throw new Error(
        "exec host=node requires a node id when multiple nodes are available (set tools.exec.node or exec.node).",
        { cause: error },
      );
    }
    throw error;
  }
  const nodeInfo = nodes.find((entry) => entry.nodeId === nodeId);
  const supportsSystemRun = Array.isArray(nodeInfo?.commands)
    ? nodeInfo?.commands?.includes("system.run")
    : false;
  if (!supportsSystemRun) {
    throw new Error(
      "exec host=node requires a node that supports system.run (companion app or node host).",
    );
  }
  const argv = buildNodeShellCommand(params.command, nodeInfo?.platform);
  const prepareRaw = await callGatewayTool<{ payload?: unknown }>(
    "node.invoke",
    { timeoutMs: 15_000 },
    {
      command: "system.run.prepare",
      idempotencyKey: crypto.randomUUID(),
      nodeId,
      params: {
        command: argv,
        rawCommand: params.command,
        ...(params.workdir != null ? { cwd: params.workdir } : {}),
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      },
    },
  );
  const prepared = parsePreparedSystemRunPayload(prepareRaw?.payload);
  if (!prepared) {
    throw new Error("invalid system.run.prepare response");
  }
  const runArgv = prepared.plan.argv;
  const runRawCommand = prepared.plan.commandText;
  const runCwd = prepared.plan.cwd ?? params.workdir;
  const runAgentId = prepared.plan.agentId ?? params.agentId;
  const runSessionKey = prepared.plan.sessionKey ?? params.sessionKey;

  const nodeEnv = params.requestedEnv ? { ...params.requestedEnv } : undefined;
  const baseAllowlistEval = evaluateShellAllowlist({
    allowlist: [],
    command: params.command,
    cwd: params.workdir,
    env: params.env,
    platform: nodeInfo?.platform,
    safeBins: new Set(),
    trustedSafeBinDirs: params.trustedSafeBinDirs,
  });
  let {analysisOk} = baseAllowlistEval;
  let allowlistSatisfied = false;
  let durableApprovalSatisfied = false;
  const inlineEvalHit =
    params.strictInlineEval === true
      ? (baseAllowlistEval.segments
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
  if ((hostAsk === "always" || hostSecurity === "allowlist") && analysisOk) {
    try {
      const approvalsSnapshot = await callGatewayTool<{ file: string }>(
        "exec.approvals.node.get",
        { timeoutMs: 10_000 },
        { nodeId },
      );
      const approvalsFile =
        approvalsSnapshot && typeof approvalsSnapshot === "object"
          ? approvalsSnapshot.file
          : undefined;
      if (approvalsFile && typeof approvalsFile === "object") {
        const resolved = resolveExecApprovalsFromFile({
          agentId: params.agentId,
          file: approvalsFile as ExecApprovalsFile,
          overrides: { security: "full" },
        });
        // Allowlist-only precheck; safe bins are node-local and may diverge.
        const allowlistEval = evaluateShellAllowlist({
          allowlist: resolved.allowlist,
          command: params.command,
          cwd: params.workdir,
          env: params.env,
          platform: nodeInfo?.platform,
          safeBins: new Set(),
          trustedSafeBinDirs: params.trustedSafeBinDirs,
        });
        durableApprovalSatisfied = hasDurableExecApproval({
          allowlist: resolved.allowlist,
          analysisOk: allowlistEval.analysisOk,
          commandText: runRawCommand,
          segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
        });
        ({ allowlistSatisfied } = allowlistEval);
        ({ analysisOk } = allowlistEval);
      }
    } catch {
      // Fall back to requiring approval if node approvals cannot be fetched.
    }
  }
  const requiresAsk =
    requiresExecApproval({
      allowlistSatisfied,
      analysisOk,
      ask: hostAsk,
      durableApprovalSatisfied,
      security: hostSecurity,
    }) || inlineEvalHit !== null;
  const invokeTimeoutMs = Math.max(
    10_000,
    (typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec) * 1000 +
      5000,
  );
  const buildInvokeParams = (
    approvedByAsk: boolean,
    approvalDecision: "allow-once" | "allow-always" | null,
    runId?: string,
    suppressNotifyOnExit?: boolean,
  ) =>
    ({
      command: "system.run",
      idempotencyKey: crypto.randomUUID(),
      nodeId,
      params: {
        agentId: runAgentId,
        approvalDecision:
          approvalDecision === "allow-always" && inlineEvalHit !== null
            ? "allow-once"
            : (approvalDecision ?? undefined),
        approved: approvedByAsk,
        command: runArgv,
        cwd: runCwd,
        env: nodeEnv,
        rawCommand: runRawCommand,
        runId: runId ?? undefined,
        sessionKey: runSessionKey,
        suppressNotifyOnExit: suppressNotifyOnExit === true ? true : undefined,
        systemRunPlan: prepared.plan,
        timeoutMs: typeof params.timeoutSec === "number" ? params.timeoutSec * 1000 : undefined,
      },
    }) satisfies Record<string, unknown>;

  let inlineApprovedByAsk = false;
  let inlineApprovalDecision: "allow-once" | "allow-always" | null = null;
  let inlineApprovalId: string | undefined;
  if (requiresAsk) {
    const requestArgs = execHostShared.buildDefaultExecApprovalRequestArgs({
      approvalRunningNoticeMs: params.approvalRunningNoticeMs,
      createApprovalSlug,
      turnSourceAccountId: params.turnSourceAccountId,
      turnSourceChannel: params.turnSourceChannel,
      warnings: params.warnings,
    });
    const registerNodeApproval = async (approvalId: string) =>
      await registerExecApprovalRequestForHostOrThrow({
        approvalId,
        ask: hostAsk,
        env: nodeEnv,
        host: "node",
        nodeId,
        security: hostSecurity,
        systemRunPlan: prepared.plan,
        workdir: runCwd,
        ...buildExecApprovalRequesterContext({
          agentId: runAgentId,
          sessionKey: runSessionKey,
        }),
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
    } = await execHostShared.createAndRegisterDefaultExecApprovalRequest({
      ...requestArgs,
      register: registerNodeApproval,
    });
    if (
      execHostShared.shouldResolveExecApprovalUnavailableInline({
        preResolvedDecision,
        trigger: params.trigger,
        unavailableReason,
      })
    ) {
      const { baseDecision, approvedByAsk, deniedReason } =
        execHostShared.createExecApprovalDecisionState({
          askFallback,
          decision: preResolvedDecision,
        });
      const strictInlineEvalDecision = execHostShared.enforceStrictInlineEvalApprovalBoundary({
        approvedByAsk,
        baseDecision,
        deniedReason,
        requiresInlineEvalApproval: inlineEvalHit !== null,
      });
      if (strictInlineEvalDecision.deniedReason || !strictInlineEvalDecision.approvedByAsk) {
        throw new Error(
          execHostShared.buildHeadlessExecApprovalDeniedMessage({
            ask: hostAsk,
            askFallback,
            host: "node",
            security: hostSecurity,
            trigger: params.trigger,
          }),
        );
      }
      inlineApprovedByAsk = strictInlineEvalDecision.approvedByAsk;
      inlineApprovalDecision = strictInlineEvalDecision.approvedByAsk ? "allow-once" : null;
      inlineApprovalId = approvalId;
    } else {
      const followupTarget = execHostShared.buildExecApprovalFollowupTarget({
        approvalId,
        sessionKey: params.notifySessionKey ?? params.sessionKey,
        turnSourceAccountId: params.turnSourceAccountId,
        turnSourceChannel: params.turnSourceChannel,
        turnSourceThreadId: params.turnSourceThreadId,
        turnSourceTo: params.turnSourceTo,
      });

      void (async () => {
        const decision = await execHostShared.resolveApprovalDecisionOrUndefined({
          approvalId,
          onFailure: () =>
            void execHostShared.sendExecApprovalFollowupResult(
              followupTarget,
              `Exec denied (node=${nodeId} id=${approvalId}, approval-request-failed): ${params.command}`,
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
        } = execHostShared.createExecApprovalDecisionState({
          askFallback,
          decision,
        });
        let approvedByAsk = initialApprovedByAsk;
        let approvalDecision: "allow-once" | "allow-always" | null = null;
        let deniedReason = initialDeniedReason;

        if (baseDecision.timedOut && askFallback === "full" && approvedByAsk) {
          approvalDecision = "allow-once";
        } else if (decision === "allow-once") {
          approvedByAsk = true;
          approvalDecision = "allow-once";
        } else if (decision === "allow-always") {
          approvedByAsk = true;
          approvalDecision = "allow-always";
        }

        ({ approvedByAsk, deniedReason } = execHostShared.enforceStrictInlineEvalApprovalBoundary({
          approvedByAsk,
          baseDecision,
          deniedReason,
          requiresInlineEvalApproval: inlineEvalHit !== null,
        }));
        if (deniedReason) {
          approvalDecision = null;
        }

        if (deniedReason) {
          await execHostShared.sendExecApprovalFollowupResult(
            followupTarget,
            `Exec denied (node=${nodeId} id=${approvalId}, ${deniedReason}): ${params.command}`,
          );
          return;
        }

        try {
          const raw = await callGatewayTool<{
            payload?: {
              stdout?: string;
              stderr?: string;
              error?: string | null;
              exitCode?: number | null;
              timedOut?: boolean;
            };
          }>(
            "node.invoke",
            { timeoutMs: invokeTimeoutMs },
            buildInvokeParams(approvedByAsk, approvalDecision, approvalId, true),
          );
          const payload =
            raw?.payload && typeof raw.payload === "object"
              ? (raw.payload as {
                  stdout?: string;
                  stderr?: string;
                  error?: string | null;
                  exitCode?: number | null;
                  timedOut?: boolean;
                })
              : {};
          const combined = [payload.stdout, payload.stderr, payload.error]
            .filter(Boolean)
            .join("\n");
          const output = normalizeNotifyOutput(combined.slice(-DEFAULT_NOTIFY_TAIL_CHARS));
          const exitLabel = payload.timedOut ? "timeout" : `code ${payload.exitCode ?? "?"}`;
          const summary = output
            ? `Exec finished (node=${nodeId} id=${approvalId}, ${exitLabel})\n${output}`
            : `Exec finished (node=${nodeId} id=${approvalId}, ${exitLabel})`;
          await execHostShared.sendExecApprovalFollowupResult(followupTarget, summary);
        } catch {
          await execHostShared.sendExecApprovalFollowupResult(
            followupTarget,
            `Exec denied (node=${nodeId} id=${approvalId}, invoke-failed): ${params.command}`,
          );
        }
      })();

      return execHostShared.buildExecApprovalPendingToolResult({
        allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: hostAsk }),
        approvalId,
        approvalSlug,
        command: params.command,
        cwd: params.workdir,
        expiresAtMs,
        host: "node",
        initiatingSurface,
        nodeId,
        sentApproverDms,
        unavailableReason,
        warningText,
      });
    }
  }

  const startedAt = Date.now();
  const raw = await callGatewayTool(
    "node.invoke",
    { timeoutMs: invokeTimeoutMs },
    buildInvokeParams(inlineApprovedByAsk, inlineApprovalDecision, inlineApprovalId),
  );
  const payload =
    raw && typeof raw === "object" ? (raw as { payload?: unknown }).payload : undefined;
  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const stdout = typeof payloadObj.stdout === "string" ? payloadObj.stdout : "";
  const stderr = typeof payloadObj.stderr === "string" ? payloadObj.stderr : "";
  const errorText = typeof payloadObj.error === "string" ? payloadObj.error : "";
  const success = typeof payloadObj.success === "boolean" ? payloadObj.success : false;
  const exitCode = typeof payloadObj.exitCode === "number" ? payloadObj.exitCode : null;
  return {
    content: [
      {
        text: stdout || stderr || errorText || "",
        type: "text",
      },
    ],
    details: {
      aggregated: [stdout, stderr, errorText].filter(Boolean).join("\n"),
      cwd: params.workdir,
      durationMs: Date.now() - startedAt,
      exitCode,
      status: success ? "completed" : "failed",
    } satisfies ExecToolDetails,
  };
}
