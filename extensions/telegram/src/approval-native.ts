import {
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { listTelegramAccountIds } from "./accounts.js";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalClientEnabled,
  isTelegramExecApprovalTargetRecipient,
  resolveTelegramExecApprovalTarget,
  shouldHandleTelegramExecApprovalRequest,
} from "./exec-approvals.js";
import { parseTelegramThreadId } from "./outbound-params.js";
import { normalizeTelegramChatId, parseTelegramTarget } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
interface TelegramOriginTarget { to: string; threadId?: number }

function resolveTurnSourceTelegramOriginTarget(
  request: ApprovalRequest,
): TelegramOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const rawTurnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
  const parsedTurnSourceTarget = rawTurnSourceTo ? parseTelegramTarget(rawTurnSourceTo) : null;
  const turnSourceTo = normalizeTelegramChatId(parsedTurnSourceTarget?.chatId ?? rawTurnSourceTo);
  if (turnSourceChannel !== "telegram" || !turnSourceTo) {
    return null;
  }
  const rawThreadId =
    request.request.turnSourceThreadId ?? parsedTurnSourceTarget?.messageThreadId ?? undefined;
  return {
    threadId: parseTelegramThreadId(rawThreadId),
    to: turnSourceTo,
  };
}

function resolveSessionTelegramOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): TelegramOriginTarget {
  return {
    threadId: parseTelegramThreadId(sessionTarget.threadId),
    to: normalizeTelegramChatId(sessionTarget.to) ?? sessionTarget.to,
  };
}

function telegramTargetsMatch(a: TelegramOriginTarget, b: TelegramOriginTarget): boolean {
  const normalizedA = normalizeTelegramChatId(a.to) ?? a.to;
  const normalizedB = normalizeTelegramChatId(b.to) ?? b.to;
  return normalizedA === normalizedB && a.threadId === b.threadId;
}

const resolveTelegramOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "telegram",
  resolveSessionTarget: resolveSessionTelegramOriginTarget,
  resolveTurnSourceTarget: resolveTurnSourceTelegramOriginTarget,
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleTelegramExecApprovalRequest({
      accountId,
      cfg,
      request,
    }),
  targetsMatch: telegramTargetsMatch,
});

const resolveTelegramApproverDmTargets = createChannelApproverDmTargetResolver({
  mapApprover: (approver) => ({ to: approver }),
  resolveApprovers: getTelegramExecApprovalApprovers,
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleTelegramExecApprovalRequest({
      accountId,
      cfg,
      request,
    }),
});

const telegramNativeApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "telegram",
  channelLabel: "Telegram",
  describeExecApprovalSetup: ({ accountId }) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.telegram.accounts.${accountId}`
        : "channels.telegram";
    return `Approve it from the Web UI or terminal UI for now. Telegram supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\`; if you leave it unset, OpenClaw can infer numeric owner IDs from \`${prefix}.allowFrom\` or direct-message \`${prefix}.defaultTo\` when possible. Leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
  },
  hasApprovers: ({ cfg, accountId }) =>
    getTelegramExecApprovalApprovers({ accountId, cfg }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isTelegramExecApprovalAuthorizedSender({ accountId, cfg, senderId }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isTelegramExecApprovalClientEnabled({ accountId, cfg }),
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isTelegramExecApprovalApprover({ accountId, cfg, senderId }),
  listAccountIds: listTelegramAccountIds,
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["exec", "plugin"],
    isConfigured: ({ cfg, accountId }) =>
      isTelegramExecApprovalClientEnabled({
        cfg,
        accountId,
      }),
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .telegramApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    shouldHandle: ({ cfg, accountId, request }) =>
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId,
        request,
      }),
  }),
  notifyOriginWhenDmOnly: true,
  requireMatchingTurnSourceChannel: true,
  resolveApproverDmTargets: resolveTelegramApproverDmTargets,
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveTelegramExecApprovalTarget({ accountId, cfg }),
  resolveOriginTarget: resolveTelegramOriginTarget,
  resolveSuppressionAccountId: ({ target, request }) =>
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId),
});

const resolveTelegramApproveCommandBehavior: NonNullable<
  ChannelApprovalCapability["resolveApproveCommandBehavior"]
> = ({ cfg, accountId, senderId, approvalKind }) => {
  if (approvalKind !== "exec") {
    return undefined;
  }
  if (isTelegramExecApprovalClientEnabled({ accountId, cfg })) {
    return undefined;
  }
  if (isTelegramExecApprovalTargetRecipient({ accountId, cfg, senderId })) {
    return undefined;
  }
  if (
    isTelegramExecApprovalAuthorizedSender({ accountId, cfg, senderId }) &&
    !isTelegramExecApprovalApprover({ accountId, cfg, senderId })
  ) {
    return undefined;
  }
  return {
    kind: "reply",
    text: "❌ Telegram exec approvals are not enabled for this bot account.",
  };
};

export const telegramApprovalCapability: ChannelApprovalCapability = {
  ...telegramNativeApprovalCapability,
  resolveApproveCommandBehavior: resolveTelegramApproveCommandBehavior,
};

export const telegramNativeApprovalAdapter = splitChannelApprovalCapability(
  telegramApprovalCapability,
);
