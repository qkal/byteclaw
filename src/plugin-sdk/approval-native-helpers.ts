import type { ExecApprovalSessionTarget } from "../infra/exec-approval-session-target.js";
import { resolveApprovalRequestOriginTarget } from "../infra/exec-approval-session-target.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { OpenClawConfig } from "./config-runtime.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";

interface ApprovalResolverParams {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ApprovalKind;
  request: ApprovalRequest;
}

interface NativeApprovalTarget {
  to: string;
  threadId?: string | number | null;
}

export function createChannelNativeOriginTargetResolver<TTarget>(params: {
  channel: string;
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
  resolveSessionTarget: (
    sessionTarget: ExecApprovalSessionTarget,
    request: ApprovalRequest,
  ) => TTarget | null;
  targetsMatch: (a: TTarget, b: TTarget) => boolean;
  resolveFallbackTarget?: (request: ApprovalRequest) => TTarget | null;
}) {
  return (input: ApprovalResolverParams): TTarget | null => {
    if (params.shouldHandleRequest && !params.shouldHandleRequest(input)) {
      return null;
    }
    return resolveApprovalRequestOriginTarget({
      accountId: input.accountId,
      cfg: input.cfg,
      channel: params.channel,
      request: input.request,
      resolveFallbackTarget: params.resolveFallbackTarget,
      resolveSessionTarget: (sessionTarget) =>
        params.resolveSessionTarget(sessionTarget, input.request),
      resolveTurnSourceTarget: params.resolveTurnSourceTarget,
      targetsMatch: params.targetsMatch,
    });
  };
}

export function createChannelApproverDmTargetResolver<
  TApprover,
  TTarget extends NativeApprovalTarget = NativeApprovalTarget,
>(params: {
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  resolveApprovers: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => readonly TApprover[];
  mapApprover: (approver: TApprover, params: ApprovalResolverParams) => TTarget | null | undefined;
}) {
  return (input: ApprovalResolverParams): TTarget[] => {
    if (params.shouldHandleRequest && !params.shouldHandleRequest(input)) {
      return [];
    }
    const targets: TTarget[] = [];
    for (const approver of params.resolveApprovers({
      accountId: input.accountId,
      cfg: input.cfg,
    })) {
      const target = params.mapApprover(approver, input);
      if (target) {
        targets.push(target);
      }
    }
    return targets;
  };
}
