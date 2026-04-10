import {
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  resolveApprovalRequestSessionConversation,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { listSlackAccountIds } from "./accounts.js";
import { isSlackApprovalAuthorizedSender } from "./approval-auth.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalAuthorizedSender,
  isSlackExecApprovalClientEnabled,
  resolveSlackExecApprovalTarget,
  shouldHandleSlackExecApprovalRequest,
} from "./exec-approvals.js";
import { parseSlackTarget } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
interface SlackOriginTarget {
  to: string;
  threadId?: string;
}

function extractSlackSessionKind(
  sessionKey?: string | null,
): "direct" | "channel" | "group" | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/slack:(direct|channel|group):/i);
  const kind = normalizeLowercaseStringOrEmpty(match?.[1]);
  return kind ? (kind as "direct" | "channel" | "group") : null;
}

function normalizeComparableTarget(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function normalizeSlackThreadMatchKey(threadId?: string): string {
  const trimmed = threadId?.trim();
  if (!trimmed) {
    return "";
  }
  const leadingEpoch = trimmed.match(/^\d+/)?.[0];
  return leadingEpoch ?? trimmed;
}

function resolveTurnSourceSlackOriginTarget(request: ApprovalRequest): SlackOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const turnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
  if (turnSourceChannel !== "slack" || !turnSourceTo) {
    return null;
  }
  const sessionKind = extractSlackSessionKind(request.request.sessionKey ?? undefined);
  const parsed = parseSlackTarget(turnSourceTo, {
    defaultKind: sessionKind === "direct" ? "user" : "channel",
  });
  if (!parsed) {
    return null;
  }
  const threadId =
    typeof request.request.turnSourceThreadId === "string"
      ? normalizeOptionalString(request.request.turnSourceThreadId)
      : typeof request.request.turnSourceThreadId === "number"
        ? String(request.request.turnSourceThreadId)
        : undefined;
  return {
    threadId,
    to: `${parsed.kind}:${parsed.id}`,
  };
}

function resolveSessionSlackOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): SlackOriginTarget {
  return {
    threadId:
      typeof sessionTarget.threadId === "string"
        ? normalizeOptionalString(sessionTarget.threadId)
        : typeof sessionTarget.threadId === "number"
          ? String(sessionTarget.threadId)
          : undefined,
    to: sessionTarget.to,
  };
}

function resolveSlackFallbackOriginTarget(request: ApprovalRequest): SlackOriginTarget | null {
  const sessionTarget = resolveApprovalRequestSessionConversation({
    channel: "slack",
    request,
  });
  if (!sessionTarget) {
    return null;
  }
  const parsed = parseSlackTarget(sessionTarget.id.toUpperCase(), {
    defaultKind: "channel",
  });
  if (!parsed) {
    return null;
  }
  return {
    threadId: sessionTarget.threadId,
    to: `${parsed.kind}:${parsed.id}`,
  };
}

function slackTargetsMatch(a: SlackOriginTarget, b: SlackOriginTarget): boolean {
  return (
    normalizeComparableTarget(a.to) === normalizeComparableTarget(b.to) &&
    normalizeSlackThreadMatchKey(a.threadId) === normalizeSlackThreadMatchKey(b.threadId)
  );
}

const resolveSlackOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "slack",
  resolveFallbackTarget: resolveSlackFallbackOriginTarget,
  resolveSessionTarget: resolveSessionSlackOriginTarget,
  resolveTurnSourceTarget: resolveTurnSourceSlackOriginTarget,
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleSlackExecApprovalRequest({
      accountId,
      cfg,
      request,
    }),
  targetsMatch: slackTargetsMatch,
});

const resolveSlackApproverDmTargets = createChannelApproverDmTargetResolver({
  mapApprover: (approver) => ({ to: `user:${approver}` }),
  resolveApprovers: getSlackExecApprovalApprovers,
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleSlackExecApprovalRequest({
      accountId,
      cfg,
      request,
    }),
});

export const slackApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "slack",
  channelLabel: "Slack",
  describeExecApprovalSetup: ({ accountId }) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.slack.accounts.${accountId}`
        : "channels.slack";
    return `Approve it from the Web UI or terminal UI for now. Slack supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
  },
  hasApprovers: ({ cfg, accountId }) =>
    getSlackExecApprovalApprovers({ accountId, cfg }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isSlackExecApprovalAuthorizedSender({ accountId, cfg, senderId }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isSlackExecApprovalClientEnabled({ accountId, cfg }),
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isSlackApprovalAuthorizedSender({ accountId, cfg, senderId }),
  listAccountIds: listSlackAccountIds,
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["exec"],
    isConfigured: ({ cfg, accountId }) =>
      isSlackExecApprovalClientEnabled({
        cfg,
        accountId,
      }),
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .slackApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    shouldHandle: ({ cfg, accountId, request }) =>
      shouldHandleSlackExecApprovalRequest({
        cfg,
        accountId,
        request,
      }),
  }),
  notifyOriginWhenDmOnly: true,
  requireMatchingTurnSourceChannel: true,
  resolveApproverDmTargets: resolveSlackApproverDmTargets,
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveSlackExecApprovalTarget({ accountId, cfg }),
  resolveOriginTarget: resolveSlackOriginTarget,
  resolveSuppressionAccountId: ({ target, request }) =>
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId),
});

export const slackNativeApprovalAdapter = splitChannelApprovalCapability(slackApprovalCapability);
