import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { formatErrorMessage } from "../infra/errors.js";
import { buildExecApprovalUnavailableReplyPayload } from "../infra/exec-approval-reply.js";
import {
  type ExecApprovalInitiatingSurfaceState,
  resolveExecApprovalInitiatingSurfaceState,
} from "../infra/exec-approval-surface.js";
import {
  type ExecApprovalDecision,
  type ExecAsk,
  type ExecSecurity,
  maxAsk,
  minSecurity,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovals,
} from "../infra/exec-approvals.js";
import { logWarn } from "../logger.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import {
  type ExecApprovalRegistration,
  resolveRegisteredExecApprovalDecision,
} from "./bash-tools.exec-approval-request.js";
import { buildApprovalPendingMessage } from "./bash-tools.exec-runtime.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";

type ResolvedExecApprovals = ReturnType<typeof resolveExecApprovals>;
export const MAX_EXEC_APPROVAL_FOLLOWUP_FAILURE_LOG_KEYS = 256;
const loggedExecApprovalFollowupFailures = new Set<string>();

function rememberExecApprovalFollowupFailureKey(key: string): boolean {
  if (loggedExecApprovalFollowupFailures.has(key)) {
    return false;
  }
  loggedExecApprovalFollowupFailures.add(key);
  // Bound memory growth for long-lived processes that see many unique approval failures.
  if (loggedExecApprovalFollowupFailures.size > MAX_EXEC_APPROVAL_FOLLOWUP_FAILURE_LOG_KEYS) {
    const oldestKey = loggedExecApprovalFollowupFailures.values().next().value;
    if (typeof oldestKey === "string") {
      loggedExecApprovalFollowupFailures.delete(oldestKey);
    }
  }
  return true;
}

export interface ExecHostApprovalContext {
  approvals: ResolvedExecApprovals;
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ResolvedExecApprovals["agent"]["askFallback"];
}

export interface ExecApprovalPendingState {
  warningText: string;
  expiresAtMs: number;
  preResolvedDecision: string | null | undefined;
}

export type ExecApprovalRequestState = ExecApprovalPendingState & {
  noticeSeconds: number;
};

export type ExecApprovalUnavailableReason =
  | "no-approval-route"
  | "initiating-platform-disabled"
  | "initiating-platform-unsupported";

function isHeadlessExecTrigger(trigger?: string): boolean {
  return trigger === "cron";
}

export interface RegisteredExecApprovalRequestContext {
  approvalId: string;
  approvalSlug: string;
  warningText: string;
  expiresAtMs: number;
  preResolvedDecision: string | null | undefined;
  initiatingSurface: ExecApprovalInitiatingSurfaceState;
  sentApproverDms: boolean;
  unavailableReason: ExecApprovalUnavailableReason | null;
}

export interface ExecApprovalFollowupTarget {
  approvalId: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}

export interface ExecApprovalFollowupResultDeps {
  sendExecApprovalFollowup?: typeof sendExecApprovalFollowup;
  logWarn?: typeof logWarn;
}

export interface DefaultExecApprovalRequestArgs {
  warnings: string[];
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
}

export function createExecApprovalPendingState(params: {
  warnings: string[];
  timeoutMs: number;
}): ExecApprovalPendingState {
  return {
    expiresAtMs: Date.now() + params.timeoutMs,
    preResolvedDecision: undefined,
    warningText: params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "",
  };
}

export function createExecApprovalRequestState(params: {
  warnings: string[];
  timeoutMs: number;
  approvalRunningNoticeMs: number;
}): ExecApprovalRequestState {
  const pendingState = createExecApprovalPendingState({
    timeoutMs: params.timeoutMs,
    warnings: params.warnings,
  });
  return {
    ...pendingState,
    noticeSeconds: Math.max(1, Math.round(params.approvalRunningNoticeMs / 1000)),
  };
}

export function createExecApprovalRequestContext(params: {
  warnings: string[];
  timeoutMs: number;
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
}): ExecApprovalRequestState & {
  approvalId: string;
  approvalSlug: string;
  contextKey: string;
} {
  const approvalId = crypto.randomUUID();
  const pendingState = createExecApprovalRequestState({
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    timeoutMs: params.timeoutMs,
    warnings: params.warnings,
  });
  return {
    ...pendingState,
    approvalId,
    approvalSlug: params.createApprovalSlug(approvalId),
    contextKey: `exec:${approvalId}`,
  };
}

export function createDefaultExecApprovalRequestContext(params: {
  warnings: string[];
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
}) {
  return createExecApprovalRequestContext({
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    createApprovalSlug: params.createApprovalSlug,
    timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    warnings: params.warnings,
  });
}

export function resolveBaseExecApprovalDecision(params: {
  decision: string | null;
  askFallback: ResolvedExecApprovals["agent"]["askFallback"];
}): {
  approvedByAsk: boolean;
  deniedReason: string | null;
  timedOut: boolean;
} {
  if (params.decision === "deny") {
    return { approvedByAsk: false, deniedReason: "user-denied", timedOut: false };
  }
  if (!params.decision) {
    if (params.askFallback === "full") {
      return { approvedByAsk: true, deniedReason: null, timedOut: true };
    }
    if (params.askFallback === "deny") {
      return { approvedByAsk: false, deniedReason: "approval-timeout", timedOut: true };
    }
    return { approvedByAsk: false, deniedReason: null, timedOut: true };
  }
  return { approvedByAsk: false, deniedReason: null, timedOut: false };
}

export function resolveExecHostApprovalContext(params: {
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  host: "gateway" | "node";
}): ExecHostApprovalContext {
  const approvals = resolveExecApprovals(params.agentId, {
    ask: params.ask,
    security: params.security,
  });
  // Session/config tool policy is the caller's requested contract. The host file
  // May tighten that contract, but it must not silently broaden it.
  const hostSecurity = minSecurity(params.security, approvals.agent.security);
  const hostAsk = maxAsk(params.ask, approvals.agent.ask);
  const askFallback = minSecurity(hostSecurity, approvals.agent.askFallback);
  if (hostSecurity === "deny") {
    throw new Error(`exec denied: host=${params.host} security=deny`);
  }
  return { approvals, askFallback, hostAsk, hostSecurity };
}

export async function resolveApprovalDecisionOrUndefined(params: {
  approvalId: string;
  preResolvedDecision: string | null | undefined;
  onFailure: () => void;
}): Promise<string | null | undefined> {
  try {
    return await resolveRegisteredExecApprovalDecision({
      approvalId: params.approvalId,
      preResolvedDecision: params.preResolvedDecision,
    });
  } catch {
    params.onFailure();
    return undefined;
  }
}

export function resolveExecApprovalUnavailableState(params: {
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
  preResolvedDecision: string | null | undefined;
}): {
  initiatingSurface: ExecApprovalInitiatingSurfaceState;
  sentApproverDms: boolean;
  unavailableReason: ExecApprovalUnavailableReason | null;
} {
  const initiatingSurface = resolveExecApprovalInitiatingSurfaceState({
    accountId: params.turnSourceAccountId,
    channel: params.turnSourceChannel,
  });
  // Native approval runtimes emit routed-elsewhere notices after actual delivery.
  // Avoid claiming approver DMs were sent from config-only guesses here.
  const sentApproverDms = false;
  const unavailableReason =
    params.preResolvedDecision === null
      ? "no-approval-route"
      : initiatingSurface.kind === "disabled"
        ? "initiating-platform-disabled"
        : initiatingSurface.kind === "unsupported"
          ? "initiating-platform-unsupported"
          : null;
  return {
    initiatingSurface,
    sentApproverDms,
    unavailableReason,
  };
}

export async function createAndRegisterDefaultExecApprovalRequest(params: {
  warnings: string[];
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
  register: (approvalId: string) => Promise<ExecApprovalRegistration>;
}): Promise<RegisteredExecApprovalRequestContext> {
  const {
    approvalId,
    approvalSlug,
    warningText,
    expiresAtMs: defaultExpiresAtMs,
    preResolvedDecision: defaultPreResolvedDecision,
  } = createDefaultExecApprovalRequestContext({
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    createApprovalSlug: params.createApprovalSlug,
    warnings: params.warnings,
  });
  const registration = await params.register(approvalId);
  const preResolvedDecision = registration.finalDecision;
  const { initiatingSurface, sentApproverDms, unavailableReason } =
    resolveExecApprovalUnavailableState({
      preResolvedDecision,
      turnSourceAccountId: params.turnSourceAccountId,
      turnSourceChannel: params.turnSourceChannel,
    });

  return {
    approvalId,
    approvalSlug,
    expiresAtMs: registration.expiresAtMs ?? defaultExpiresAtMs,
    initiatingSurface,
    preResolvedDecision:
      registration.finalDecision === undefined
        ? defaultPreResolvedDecision
        : registration.finalDecision,
    sentApproverDms,
    unavailableReason,
    warningText,
  };
}

export function buildDefaultExecApprovalRequestArgs(
  params: DefaultExecApprovalRequestArgs,
): DefaultExecApprovalRequestArgs {
  return {
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    createApprovalSlug: params.createApprovalSlug,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceChannel: params.turnSourceChannel,
    warnings: params.warnings,
  };
}

export function buildExecApprovalFollowupTarget(
  params: ExecApprovalFollowupTarget,
): ExecApprovalFollowupTarget {
  return {
    approvalId: params.approvalId,
    sessionKey: params.sessionKey,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceChannel: params.turnSourceChannel,
    turnSourceThreadId: params.turnSourceThreadId,
    turnSourceTo: params.turnSourceTo,
  };
}

export function createExecApprovalDecisionState(params: {
  decision: string | null | undefined;
  askFallback: ResolvedExecApprovals["agent"]["askFallback"];
}) {
  const baseDecision = resolveBaseExecApprovalDecision({
    askFallback: params.askFallback,
    decision: params.decision ?? null,
  });
  return {
    approvedByAsk: baseDecision.approvedByAsk,
    baseDecision,
    deniedReason: baseDecision.deniedReason,
  };
}

export function enforceStrictInlineEvalApprovalBoundary(params: {
  baseDecision: {
    timedOut: boolean;
  };
  approvedByAsk: boolean;
  deniedReason: string | null;
  requiresInlineEvalApproval: boolean;
}): {
  approvedByAsk: boolean;
  deniedReason: string | null;
} {
  if (
    !params.baseDecision.timedOut ||
    !params.requiresInlineEvalApproval ||
    !params.approvedByAsk
  ) {
    return {
      approvedByAsk: params.approvedByAsk,
      deniedReason: params.deniedReason,
    };
  }
  return {
    approvedByAsk: false,
    deniedReason: params.deniedReason ?? "approval-timeout",
  };
}

export function shouldResolveExecApprovalUnavailableInline(params: {
  trigger?: string;
  unavailableReason: ExecApprovalUnavailableReason | null;
  preResolvedDecision: string | null | undefined;
}): boolean {
  return (
    isHeadlessExecTrigger(params.trigger) &&
    params.unavailableReason === "no-approval-route" &&
    params.preResolvedDecision === null
  );
}

export function buildHeadlessExecApprovalDeniedMessage(params: {
  trigger?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  askFallback: ResolvedExecApprovals["agent"]["askFallback"];
}): string {
  const runLabel = params.trigger === "cron" ? "Cron runs" : "Headless runs";
  return [
    `exec denied: ${runLabel} cannot wait for interactive exec approval.`,
    `Effective host exec policy: security=${params.security} ask=${params.ask} askFallback=${params.askFallback}`,
    "Stricter values from tools.exec and ~/.openclaw/exec-approvals.json both apply.",
    "Fix one of these:",
    '- align both files to security="full" and ask="off" for trusted local automation',
    "- keep allowlist mode and add an explicit allowlist entry for this command",
    "- enable Web UI, terminal UI, or chat exec approvals and rerun interactively",
    'Tip: run "openclaw doctor" and "openclaw approvals get --gateway" to inspect the effective policy.',
  ].join("\n");
}

export async function sendExecApprovalFollowupResult(
  target: ExecApprovalFollowupTarget,
  resultText: string,
  deps: ExecApprovalFollowupResultDeps = {},
): Promise<void> {
  const send = deps.sendExecApprovalFollowup ?? sendExecApprovalFollowup;
  const warn = deps.logWarn ?? logWarn;
  await send({
    approvalId: target.approvalId,
    resultText,
    sessionKey: target.sessionKey,
    turnSourceAccountId: target.turnSourceAccountId,
    turnSourceChannel: target.turnSourceChannel,
    turnSourceThreadId: target.turnSourceThreadId,
    turnSourceTo: target.turnSourceTo,
  }).catch((error) => {
    const message = formatErrorMessage(error);
    const key = `${target.approvalId}:${message}`;
    if (!rememberExecApprovalFollowupFailureKey(key)) {
      return;
    }
    warn(`exec approval followup dispatch failed (id=${target.approvalId}): ${message}`);
  });
}

export function buildExecApprovalPendingToolResult(params: {
  host: "gateway" | "node";
  command: string;
  cwd: string | undefined;
  warningText: string;
  approvalId: string;
  approvalSlug: string;
  expiresAtMs: number;
  initiatingSurface: ExecApprovalInitiatingSurfaceState;
  sentApproverDms: boolean;
  unavailableReason: ExecApprovalUnavailableReason | null;
  allowedDecisions?: readonly ExecApprovalDecision[];
  nodeId?: string;
}): AgentToolResult<ExecToolDetails> {
  const allowedDecisions = params.allowedDecisions ?? resolveExecApprovalAllowedDecisions();
  return {
    content: [
      {
        text:
          params.unavailableReason !== null
            ? (buildExecApprovalUnavailableReplyPayload({
                accountId: params.initiatingSurface.accountId,
                channel: params.initiatingSurface.channel,
                channelLabel: params.initiatingSurface.channelLabel,
                reason: params.unavailableReason,
                sentApproverDms: params.sentApproverDms,
                warningText: params.warningText,
              }).text ?? "")
            : buildApprovalPendingMessage({
                allowedDecisions,
                approvalId: params.approvalId,
                approvalSlug: params.approvalSlug,
                command: params.command,
                cwd: params.cwd,
                host: params.host,
                nodeId: params.nodeId,
                warningText: params.warningText,
              }),
        type: "text",
      },
    ],
    details:
      params.unavailableReason !== null
        ? ({
            accountId: params.initiatingSurface.accountId,
            channel: params.initiatingSurface.channel,
            channelLabel: params.initiatingSurface.channelLabel,
            command: params.command,
            cwd: params.cwd,
            host: params.host,
            nodeId: params.nodeId,
            reason: params.unavailableReason,
            sentApproverDms: params.sentApproverDms,
            status: "approval-unavailable",
            warningText: params.warningText,
          } satisfies ExecToolDetails)
        : ({
            allowedDecisions,
            approvalId: params.approvalId,
            approvalSlug: params.approvalSlug,
            command: params.command,
            cwd: params.cwd,
            expiresAtMs: params.expiresAtMs,
            host: params.host,
            nodeId: params.nodeId,
            status: "approval-pending",
            warningText: params.warningText,
          } satisfies ExecToolDetails),
  };
}
