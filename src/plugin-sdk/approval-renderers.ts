import type { ReplyPayload } from "../auto-reply/types.js";
import {
  type ExecApprovalReplyDecision,
  buildApprovalInteractiveReply,
} from "../infra/exec-approval-reply.js";
import {
  type PluginApprovalRequest,
  type PluginApprovalResolved,
  buildPluginApprovalRequestMessage,
  buildPluginApprovalResolvedMessage,
} from "../infra/plugin-approvals.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const DEFAULT_ALLOWED_DECISIONS = ["allow-once", "allow-always", "deny"] as const;

export function buildApprovalPendingReplyPayload(params: {
  approvalKind?: "exec" | "plugin";
  approvalId: string;
  approvalSlug: string;
  text: string;
  agentId?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  sessionKey?: string | null;
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  const allowedDecisions = params.allowedDecisions ?? DEFAULT_ALLOWED_DECISIONS;
  return {
    channelData: {
      execApproval: {
        agentId: normalizeOptionalString(params.agentId),
        allowedDecisions,
        approvalId: params.approvalId,
        approvalKind: params.approvalKind ?? "exec",
        approvalSlug: params.approvalSlug,
        sessionKey: normalizeOptionalString(params.sessionKey),
        state: "pending",
      },
      ...params.channelData,
    },
    interactive: buildApprovalInteractiveReply({
      allowedDecisions,
      approvalId: params.approvalId,
    }),
    text: params.text,
  };
}

export function buildApprovalResolvedReplyPayload(params: {
  approvalId: string;
  approvalSlug: string;
  text: string;
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return {
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        state: "resolved",
      },
      ...params.channelData,
    },
    text: params.text,
  };
}

export function buildPluginApprovalPendingReplyPayload(params: {
  request: PluginApprovalRequest;
  nowMs: number;
  text?: string;
  approvalSlug?: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return buildApprovalPendingReplyPayload({
    allowedDecisions: params.allowedDecisions,
    approvalId: params.request.id,
    approvalKind: "plugin",
    approvalSlug: params.approvalSlug ?? params.request.id.slice(0, 8),
    channelData: params.channelData,
    text: params.text ?? buildPluginApprovalRequestMessage(params.request, params.nowMs),
  });
}

export function buildPluginApprovalResolvedReplyPayload(params: {
  resolved: PluginApprovalResolved;
  text?: string;
  approvalSlug?: string;
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return buildApprovalResolvedReplyPayload({
    approvalId: params.resolved.id,
    approvalSlug: params.approvalSlug ?? params.resolved.id.slice(0, 8),
    channelData: params.channelData,
    text: params.text ?? buildPluginApprovalResolvedMessage(params.resolved),
  });
}
