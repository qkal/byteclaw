import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  getExecApprovalReplyMetadata,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { resolveApprovalRequestChannelAccountId } from "openclaw/plugin-sdk/approval-native-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { getMatrixApprovalAuthApprovers } from "./approval-auth.js";
import { normalizeMatrixApproverId } from "./approval-ids.js";
import { listMatrixAccountIds, resolveMatrixAccount } from "./matrix/accounts.js";
import type { CoreConfig } from "./types.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";

export { normalizeMatrixApproverId };

function normalizeMatrixExecApproverId(value: string | number): string | undefined {
  const normalized = normalizeMatrixApproverId(value);
  return normalized === "*" ? undefined : normalized;
}

function resolveMatrixExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const account = resolveMatrixAccount(params);
  const config = account.config.execApprovals;
  if (!config) {
    return undefined;
  }
  return {
    ...config,
    enabled: account.enabled && account.configured ? config.enabled : false,
  };
}

function countMatrixExecApprovalEligibleAccounts(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequest;
  approvalKind: ApprovalKind;
}): number {
  return listMatrixAccountIds(params.cfg).filter((accountId) => {
    const account = resolveMatrixAccount({ accountId, cfg: params.cfg });
    if (!account.enabled || !account.configured) {
      return false;
    }
    const config = resolveMatrixExecApprovalConfig({
      accountId,
      cfg: params.cfg,
    });
    const filters = config?.enabled
      ? {
          agentFilter: config.agentFilter,
          sessionFilter: config.sessionFilter,
        }
      : {
          agentFilter: undefined,
          sessionFilter: undefined,
        };
    return (
      isChannelExecApprovalClientEnabledFromConfig({
        approverCount: getMatrixApprovalApprovers({
          accountId,
          approvalKind: params.approvalKind,
          cfg: params.cfg,
        }).length,
        enabled: config?.enabled,
      }) &&
      matchesApprovalRequestFilters({
        agentFilter: filters.agentFilter,
        request: params.request.request,
        sessionFilter: filters.sessionFilter,
      })
    );
  }).length;
}

function matchesMatrixRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  approvalKind: ApprovalKind;
}): boolean {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(
    params.request.request.turnSourceChannel,
  );
  const boundAccountId = resolveApprovalRequestChannelAccountId({
    cfg: params.cfg,
    channel: "matrix",
    request: params.request,
  });
  if (turnSourceChannel && turnSourceChannel !== "matrix" && !boundAccountId) {
    return (
      countMatrixExecApprovalEligibleAccounts({
        approvalKind: params.approvalKind,
        cfg: params.cfg,
        request: params.request,
      }) <= 1
    );
  }
  return (
    !boundAccountId ||
    !params.accountId ||
    normalizeAccountId(boundAccountId) === normalizeAccountId(params.accountId)
  );
}

export function getMatrixExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveMatrixAccount(params).config;
  return resolveApprovalApprovers({
    allowFrom: account.dm?.allowFrom,
    explicit: account.execApprovals?.approvers,
    normalizeApprover: normalizeMatrixExecApproverId,
  });
}

function resolveMatrixApprovalKind(request: ApprovalRequest): ApprovalKind {
  return request.id.startsWith("plugin:") ? "plugin" : "exec";
}

export function getMatrixApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
}): string[] {
  if (params.approvalKind === "plugin") {
    return getMatrixApprovalAuthApprovers({
      accountId: params.accountId,
      cfg: params.cfg as CoreConfig,
    });
  }
  return getMatrixExecApprovalApprovers(params);
}

export function isMatrixExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalTargetRecipient({
    ...params,
    channel: "matrix",
    matchTarget: ({ target, normalizedSenderId }) =>
      normalizeMatrixApproverId(target.to) === normalizedSenderId,
    normalizeSenderId: normalizeMatrixApproverId,
  });
}

const matrixExecApprovalProfile = createChannelExecApprovalProfile({
  isTargetRecipient: isMatrixExecApprovalTargetRecipient,
  matchesRequestAccount: (params) =>
    matchesMatrixRequestAccount({
      ...params,
      approvalKind: "exec",
    }),
  normalizeSenderId: normalizeMatrixApproverId,
  resolveApprovers: getMatrixExecApprovalApprovers,
  resolveConfig: resolveMatrixExecApprovalConfig,
});

export const isMatrixExecApprovalClientEnabled = matrixExecApprovalProfile.isClientEnabled;
export const isMatrixExecApprovalApprover = matrixExecApprovalProfile.isApprover;
export const isMatrixExecApprovalAuthorizedSender = matrixExecApprovalProfile.isAuthorizedSender;
export const resolveMatrixExecApprovalTarget = matrixExecApprovalProfile.resolveTarget;
export const shouldHandleMatrixExecApprovalRequest = matrixExecApprovalProfile.shouldHandleRequest;

export function isMatrixApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
}): boolean {
  if (params.approvalKind === "exec") {
    return isMatrixExecApprovalClientEnabled(params);
  }
  const config = resolveMatrixExecApprovalConfig(params);
  return isChannelExecApprovalClientEnabledFromConfig({
    approverCount: getMatrixApprovalApprovers(params).length,
    enabled: config?.enabled,
  });
}

export function isMatrixAnyApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return (
    isMatrixApprovalClientEnabled({
      ...params,
      approvalKind: "exec",
    }) ||
    isMatrixApprovalClientEnabled({
      ...params,
      approvalKind: "plugin",
    })
  );
}

export function shouldHandleMatrixApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  const approvalKind = resolveMatrixApprovalKind(params.request);
  if (
    !matchesMatrixRequestAccount({
      ...params,
      approvalKind,
    })
  ) {
    return false;
  }
  const config = resolveMatrixExecApprovalConfig(params);
  if (
    !isChannelExecApprovalClientEnabledFromConfig({
      approverCount: getMatrixApprovalApprovers({
        ...params,
        approvalKind,
      }).length,
      enabled: config?.enabled,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    agentFilter: config?.agentFilter,
    request: params.request.request,
    sessionFilter: config?.sessionFilter,
  });
}

function buildFilterCheckRequest(params: {
  metadata: NonNullable<ReturnType<typeof getExecApprovalReplyMetadata>>;
}): ApprovalRequest {
  if (params.metadata.approvalKind === "plugin") {
    return {
      createdAtMs: 0,
      expiresAtMs: 0,
      id: params.metadata.approvalId,
      request: {
        agentId: params.metadata.agentId ?? null,
        description: "",
        sessionKey: params.metadata.sessionKey ?? null,
        title: "Plugin Approval Required",
      },
    };
  }
  return {
    createdAtMs: 0,
    expiresAtMs: 0,
    id: params.metadata.approvalId,
    request: {
      agentId: params.metadata.agentId ?? null,
      command: "",
      sessionKey: params.metadata.sessionKey ?? null,
    },
  };
}

export function shouldSuppressLocalMatrixExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  if (!matrixExecApprovalProfile.shouldSuppressLocalPrompt(params)) {
    return false;
  }
  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (!metadata) {
    return false;
  }
  const request = buildFilterCheckRequest({
    metadata,
  });
  return shouldHandleMatrixApprovalRequest({
    accountId: params.accountId,
    cfg: params.cfg,
    request,
  });
}
