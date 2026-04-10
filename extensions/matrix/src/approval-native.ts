import {
  createApproverRestrictedNativeApprovalCapability,
  createChannelApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelNativeOriginTargetResolver,
  resolveApprovalRequestSessionConversation,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import { getMatrixApprovalAuthApprovers, matrixApprovalAuth } from "./approval-auth.js";
import { normalizeMatrixApproverId } from "./approval-ids.js";
import {
  getMatrixApprovalApprovers,
  getMatrixExecApprovalApprovers,
  isMatrixAnyApprovalClientEnabled,
  isMatrixApprovalClientEnabled,
  isMatrixExecApprovalAuthorizedSender,
  isMatrixExecApprovalClientEnabled,
  resolveMatrixExecApprovalTarget,
  shouldHandleMatrixApprovalRequest,
} from "./exec-approvals.js";
import { listMatrixAccountIds } from "./matrix/accounts.js";
import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";
import type { CoreConfig } from "./types.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";
interface MatrixOriginTarget { to: string; threadId?: string }

function normalizeComparableTarget(value: string): string {
  const target = resolveMatrixTargetIdentity(value);
  if (!target) {
    return normalizeLowercaseStringOrEmpty(value);
  }
  if (target.kind === "user") {
    return `user:${normalizeMatrixUserId(target.id)}`;
  }
  return `${normalizeLowercaseStringOrEmpty(target.kind)}:${target.id}`;
}

function resolveMatrixNativeTarget(raw: string): string | null {
  const target = resolveMatrixTargetIdentity(raw);
  if (!target) {
    return null;
  }
  return target.kind === "user" ? `user:${target.id}` : `room:${target.id}`;
}

function resolveTurnSourceMatrixOriginTarget(request: ApprovalRequest): MatrixOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const turnSourceTo = request.request.turnSourceTo?.trim() || "";
  const target = resolveMatrixNativeTarget(turnSourceTo);
  if (turnSourceChannel !== "matrix" || !target) {
    return null;
  }
  return {
    threadId: normalizeOptionalStringifiedId(request.request.turnSourceThreadId),
    to: target,
  };
}

function resolveSessionMatrixOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): MatrixOriginTarget | null {
  const target = resolveMatrixNativeTarget(sessionTarget.to);
  if (!target) {
    return null;
  }
  return {
    threadId: normalizeOptionalStringifiedId(sessionTarget.threadId),
    to: target,
  };
}

function matrixTargetsMatch(a: MatrixOriginTarget, b: MatrixOriginTarget): boolean {
  return (
    normalizeComparableTarget(a.to) === normalizeComparableTarget(b.to) &&
    (a.threadId ?? "") === (b.threadId ?? "")
  );
}

function hasMatrixPluginApprovers(params: { cfg: CoreConfig; accountId?: string | null }): boolean {
  return getMatrixApprovalAuthApprovers(params).length > 0;
}

function availabilityState(enabled: boolean) {
  return enabled ? ({ kind: "enabled" } as const) : ({ kind: "disabled" } as const);
}

function hasMatrixApprovalApprovers(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
}): boolean {
  return (
    getMatrixApprovalApprovers({
      accountId: params.accountId,
      approvalKind: params.approvalKind,
      cfg: params.cfg,
    }).length > 0
  );
}

function hasAnyMatrixApprovalApprovers(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): boolean {
  return (
    getMatrixExecApprovalApprovers(params).length > 0 ||
    getMatrixApprovalAuthApprovers(params).length > 0
  );
}

function isMatrixPluginAuthorizedSender(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const normalizedSenderId = params.senderId
    ? normalizeMatrixApproverId(params.senderId)
    : undefined;
  if (!normalizedSenderId) {
    return false;
  }
  return getMatrixApprovalAuthApprovers(params).includes(normalizedSenderId);
}

function resolveSuppressionAccountId(params: {
  target: { accountId?: string | null };
  request: { request: { turnSourceAccountId?: string | null } };
}): string | undefined {
  return (
    params.target.accountId?.trim() ||
    params.request.request.turnSourceAccountId?.trim() ||
    undefined
  );
}

const resolveMatrixOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "matrix",
  resolveFallbackTarget: (request) => {
    const sessionConversation = resolveApprovalRequestSessionConversation({
      channel: "matrix",
      request,
    });
    if (!sessionConversation) {
      return null;
    }
    const target = resolveMatrixNativeTarget(sessionConversation.id);
    if (!target) {
      return null;
    }
    return {
      threadId: normalizeOptionalStringifiedId(sessionConversation.threadId),
      to: target,
    };
  },
  resolveSessionTarget: resolveSessionMatrixOriginTarget,
  resolveTurnSourceTarget: resolveTurnSourceMatrixOriginTarget,
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleMatrixApprovalRequest({
      accountId,
      cfg,
      request,
    }),
  targetsMatch: matrixTargetsMatch,
});

function resolveMatrixApproverDmTargets(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
}): { to: string }[] {
  if (!shouldHandleMatrixApprovalRequest(params)) {
    return [];
  }
  return getMatrixApprovalApprovers(params)
    .map((approver) => {
      const normalized = normalizeMatrixUserId(approver);
      return normalized ? { to: `user:${normalized}` } : null;
    })
    .filter((target): target is { to: string } => target !== null);
}

const matrixNativeApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "matrix",
  channelLabel: "Matrix",
  describeExecApprovalSetup: ({ accountId }) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.matrix.accounts.${accountId}`
        : "channels.matrix";
    return `Approve it from the Web UI or terminal UI for now. Matrix supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`${prefix}.dm.allowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
  },
  hasApprovers: ({ cfg, accountId }) =>
    hasAnyMatrixApprovalApprovers({
      accountId,
      cfg: cfg as CoreConfig,
    }),
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isMatrixExecApprovalAuthorizedSender({ accountId, cfg, senderId }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isMatrixExecApprovalClientEnabled({ accountId, cfg }),
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isMatrixPluginAuthorizedSender({
      accountId,
      cfg: cfg as CoreConfig,
      senderId,
    }),
  listAccountIds: listMatrixAccountIds,
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["exec", "plugin"],
    isConfigured: ({ cfg, accountId }) =>
      isMatrixAnyApprovalClientEnabled({
        cfg,
        accountId,
      }),
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .matrixApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    shouldHandle: ({ cfg, accountId, request }) =>
      shouldHandleMatrixApprovalRequest({
        cfg,
        accountId,
        request,
      }),
  }),
  notifyOriginWhenDmOnly: true,
  requireMatchingTurnSourceChannel: true,
  resolveApproverDmTargets: resolveMatrixApproverDmTargets,
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveMatrixExecApprovalTarget({ accountId, cfg }),
  resolveOriginTarget: resolveMatrixOriginTarget,
  resolveSuppressionAccountId,
});

const splitMatrixApprovalCapability = splitChannelApprovalCapability(
  matrixNativeApprovalCapability,
);
const matrixBaseNativeApprovalAdapter = splitMatrixApprovalCapability.native;
const matrixBaseDeliveryAdapter = splitMatrixApprovalCapability.delivery;
type MatrixForwardingSuppressionParams = Parameters<
  NonNullable<NonNullable<typeof matrixBaseDeliveryAdapter>["shouldSuppressForwardingFallback"]>
>[0];
const matrixDeliveryAdapter = matrixBaseDeliveryAdapter && {
  ...matrixBaseDeliveryAdapter,
  shouldSuppressForwardingFallback: (params: MatrixForwardingSuppressionParams) => {
    const accountId = resolveSuppressionAccountId(params);
    if (
      !hasMatrixApprovalApprovers({
        accountId,
        approvalKind: params.approvalKind,
        cfg: params.cfg as CoreConfig,
      })
    ) {
      return false;
    }
    return matrixBaseDeliveryAdapter.shouldSuppressForwardingFallback?.(params) ?? false;
  },
};
const matrixNativeAdapter = matrixBaseNativeApprovalAdapter && {
  describeDeliveryCapabilities: (
    params: Parameters<typeof matrixBaseNativeApprovalAdapter.describeDeliveryCapabilities>[0],
  ) => {
    const capabilities = matrixBaseNativeApprovalAdapter.describeDeliveryCapabilities(params);
    const hasApprovers = hasMatrixApprovalApprovers({
      accountId: params.accountId,
      approvalKind: params.approvalKind,
      cfg: params.cfg as CoreConfig,
    });
    const clientEnabled = isMatrixApprovalClientEnabled({
      accountId: params.accountId,
      approvalKind: params.approvalKind,
      cfg: params.cfg,
    });
    return {
      ...capabilities,
      enabled: capabilities.enabled && hasApprovers && clientEnabled,
    };
  },
  resolveApproverDmTargets: matrixBaseNativeApprovalAdapter.resolveApproverDmTargets,
  resolveOriginTarget: matrixBaseNativeApprovalAdapter.resolveOriginTarget,
};

export const matrixApprovalCapability = createChannelApprovalCapability({
  authorizeActorAction: (params) => {
    if (params.approvalKind !== "plugin") {
      return matrixNativeApprovalCapability.authorizeActorAction?.(params) ?? { authorized: true };
    }
    if (
      !hasMatrixPluginApprovers({
        accountId: params.accountId,
        cfg: params.cfg as CoreConfig,
      })
    ) {
      return {
        authorized: false,
        reason: "❌ Matrix plugin approvals are not enabled for this bot account.",
      } as const;
    }
    return matrixApprovalAuth.authorizeActorAction(params);
  },
  delivery: matrixDeliveryAdapter,
  describeExecApprovalSetup: matrixNativeApprovalCapability.describeExecApprovalSetup,
  getActionAvailabilityState: (params) => {
    if (params.approvalKind === "plugin") {
      return availabilityState(
        hasMatrixPluginApprovers({
          accountId: params.accountId,
          cfg: params.cfg as CoreConfig,
        }),
      );
    }
    return (
      matrixNativeApprovalCapability.getActionAvailabilityState?.(params) ?? {
        kind: "disabled",
      }
    );
  },
  getExecInitiatingSurfaceState: (params) =>
    matrixNativeApprovalCapability.getExecInitiatingSurfaceState?.(params) ??
    ({ kind: "disabled" } as const),
  native: matrixNativeAdapter,
  nativeRuntime: matrixNativeApprovalCapability.nativeRuntime,
  render: matrixNativeApprovalCapability.render,
});
