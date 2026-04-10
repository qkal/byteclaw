import { resolveSystemRunApprovalRuntimeContext } from "../infra/system-run-approval-context.js";
import { resolveSystemRunCommandRequest } from "../infra/system-run-command.js";
import { asNullableRecord } from "../shared/record-coerce.js";
import { normalizeNullableString } from "../shared/string-coerce.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.js";
import {
  systemRunApprovalGuardError,
  systemRunApprovalRequired,
} from "./node-invoke-system-run-approval-errors.js";
import {
  evaluateSystemRunApprovalMatch,
  toSystemRunApprovalMismatchError,
} from "./node-invoke-system-run-approval-match.js";

interface SystemRunParamsLike {
  command?: unknown;
  rawCommand?: unknown;
  systemRunPlan?: unknown;
  cwd?: unknown;
  env?: unknown;
  timeoutMs?: unknown;
  needsScreenRecording?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  approved?: unknown;
  approvalDecision?: unknown;
  runId?: unknown;
  suppressNotifyOnExit?: unknown;
}

interface ApprovalLookup {
  getSnapshot: (recordId: string) => ExecApprovalRecord | null;
  consumeAllowOnce?: (recordId: string) => boolean;
}

interface ApprovalClient {
  connId?: string | null;
  connect?: {
    scopes?: unknown;
    device?: { id?: string | null } | null;
  } | null;
}

function normalizeApprovalDecision(value: unknown): "allow-once" | "allow-always" | null {
  const s = normalizeNullableString(value);
  return s === "allow-once" || s === "allow-always" ? s : null;
}

function clientHasApprovals(client: ApprovalClient | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client?.connect?.scopes : [];
  return scopes.includes("operator.admin") || scopes.includes("operator.approvals");
}

function pickSystemRunParams(raw: Record<string, unknown>): Record<string, unknown> {
  // Defensive allowlist: only forward fields that the node-host `system.run` handler understands.
  // This prevents future internal control fields from being smuggled through the gateway.
  const next: Record<string, unknown> = {};
  for (const key of [
    "command",
    "rawCommand",
    "systemRunPlan",
    "cwd",
    "env",
    "timeoutMs",
    "needsScreenRecording",
    "agentId",
    "sessionKey",
    "runId",
    "suppressNotifyOnExit",
  ]) {
    if (key in raw) {
      next[key] = raw[key];
    }
  }
  return next;
}

/**
 * Gate `system.run` approval flags (`approved`, `approvalDecision`) behind a real
 * `exec.approval.*` record. This prevents users with only `operator.write` from
 * bypassing node-host approvals by injecting control fields into `node.invoke`.
 */
export function sanitizeSystemRunParamsForForwarding(opts: {
  nodeId?: string | null;
  rawParams: unknown;
  client: ApprovalClient | null;
  execApprovalManager?: ApprovalLookup;
  nowMs?: number;
}):
  | { ok: true; params: unknown }
  | { ok: false; message: string; details?: Record<string, unknown> } {
  const obj = asNullableRecord(opts.rawParams);
  if (!obj) {
    return { ok: true, params: opts.rawParams };
  }

  const p = obj as SystemRunParamsLike;
  const approved = p.approved === true;
  const requestedDecision = normalizeApprovalDecision(p.approvalDecision);
  const wantsApprovalOverride = approved || requestedDecision !== null;

  // Always strip control fields from user input. If the override is allowed,
  // We re-add trusted fields based on the gateway approval record.
  const next: Record<string, unknown> = pickSystemRunParams(obj);

  if (!wantsApprovalOverride) {
    const cmdTextResolution = resolveSystemRunCommandRequest({
      command: p.command,
      rawCommand: p.rawCommand,
    });
    if (!cmdTextResolution.ok) {
      return {
        details: cmdTextResolution.details,
        message: cmdTextResolution.message,
        ok: false,
      };
    }
    return { ok: true, params: next };
  }

  const runId = normalizeNullableString(p.runId);
  if (!runId) {
    return systemRunApprovalGuardError({
      code: "MISSING_RUN_ID",
      message: "approval override requires params.runId",
    });
  }

  const manager = opts.execApprovalManager;
  if (!manager) {
    return systemRunApprovalGuardError({
      code: "APPROVALS_UNAVAILABLE",
      message: "exec approvals unavailable",
    });
  }

  const snapshot = manager.getSnapshot(runId);
  if (!snapshot) {
    return systemRunApprovalGuardError({
      code: "UNKNOWN_APPROVAL_ID",
      details: { runId },
      message: "unknown or expired approval id",
    });
  }

  const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
  if (nowMs > snapshot.expiresAtMs) {
    return systemRunApprovalGuardError({
      code: "APPROVAL_EXPIRED",
      details: { runId },
      message: "approval expired",
    });
  }

  const targetNodeId = normalizeNullableString(opts.nodeId);
  if (!targetNodeId) {
    return systemRunApprovalGuardError({
      code: "MISSING_NODE_ID",
      details: { runId },
      message: "node.invoke requires nodeId",
    });
  }
  const approvalNodeId = normalizeNullableString(snapshot.request.nodeId);
  if (!approvalNodeId) {
    return systemRunApprovalGuardError({
      code: "APPROVAL_NODE_BINDING_MISSING",
      details: { runId },
      message: "approval id missing node binding",
    });
  }
  if (approvalNodeId !== targetNodeId) {
    return systemRunApprovalGuardError({
      code: "APPROVAL_NODE_MISMATCH",
      details: { runId },
      message: "approval id not valid for this node",
    });
  }

  // Prefer binding by device identity (stable across reconnects / per-call clients like callGateway()).
  // Fallback to connId only when device identity is not available.
  const snapshotDeviceId = snapshot.requestedByDeviceId ?? null;
  const clientDeviceId = opts.client?.connect?.device?.id ?? null;
  if (snapshotDeviceId) {
    if (snapshotDeviceId !== clientDeviceId) {
      return systemRunApprovalGuardError({
        code: "APPROVAL_DEVICE_MISMATCH",
        details: { runId },
        message: "approval id not valid for this device",
      });
    }
  } else if (
    snapshot.requestedByConnId &&
    snapshot.requestedByConnId !== (opts.client?.connId ?? null)
  ) {
    return systemRunApprovalGuardError({
      code: "APPROVAL_CLIENT_MISMATCH",
      details: { runId },
      message: "approval id not valid for this client",
    });
  }

  const runtimeContext = resolveSystemRunApprovalRuntimeContext({
    agentId: p.agentId,
    command: p.command,
    cwd: p.cwd,
    plan: snapshot.request.systemRunPlan ?? null,
    rawCommand: p.rawCommand,
    sessionKey: p.sessionKey,
  });
  if (!runtimeContext.ok) {
    return {
      details: runtimeContext.details,
      message: runtimeContext.message,
      ok: false,
    };
  }
  if (runtimeContext.plan) {
    next.command = [...runtimeContext.plan.argv];
    next.systemRunPlan = runtimeContext.plan;
    if (runtimeContext.commandText) {
      next.rawCommand = runtimeContext.commandText;
    } else {
      delete next.rawCommand;
    }
    if (runtimeContext.cwd) {
      next.cwd = runtimeContext.cwd;
    } else {
      delete next.cwd;
    }
    if (runtimeContext.agentId) {
      next.agentId = runtimeContext.agentId;
    } else {
      delete next.agentId;
    }
    if (runtimeContext.sessionKey) {
      next.sessionKey = runtimeContext.sessionKey;
    } else {
      delete next.sessionKey;
    }
  }

  const approvalMatch = evaluateSystemRunApprovalMatch({
    argv: runtimeContext.argv,
    binding: {
      agentId: runtimeContext.agentId,
      cwd: runtimeContext.cwd,
      env: p.env,
      sessionKey: runtimeContext.sessionKey,
    },
    request: snapshot.request,
  });
  if (!approvalMatch.ok) {
    return toSystemRunApprovalMismatchError({ match: approvalMatch, runId });
  }

  // Normal path: enforce the decision recorded by the gateway.
  if (snapshot.decision === "allow-once") {
    if (typeof manager.consumeAllowOnce !== "function" || !manager.consumeAllowOnce(runId)) {
      return systemRunApprovalRequired(runId);
    }
    next.approved = true;
    next.approvalDecision = "allow-once";
    return { ok: true, params: next };
  }

  if (snapshot.decision === "allow-always") {
    next.approved = true;
    next.approvalDecision = "allow-always";
    return { ok: true, params: next };
  }

  // If the approval request timed out (decision=null), allow askFallback-driven
  // "allow-once" ONLY for clients that are allowed to use exec approvals.
  const timedOut =
    snapshot.resolvedAtMs !== undefined &&
    snapshot.decision === undefined &&
    snapshot.resolvedBy === null;
  if (
    timedOut &&
    approved &&
    requestedDecision === "allow-once" &&
    clientHasApprovals(opts.client)
  ) {
    next.approved = true;
    next.approvalDecision = "allow-once";
    return { ok: true, params: next };
  }

  return systemRunApprovalRequired(runId);
}
