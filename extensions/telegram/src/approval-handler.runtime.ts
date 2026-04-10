import type {
  ChannelApprovalCapabilityHandlerContext,
  PendingApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { buildPluginApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  type ExecApprovalPendingReplyParams,
  type ExecApprovalRequest,
  type PluginApprovalRequest,
  buildApprovalInteractiveReplyFromActionDescriptors,
  buildExecApprovalPendingReplyPayload,
} from "openclaw/plugin-sdk/infra-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveTelegramInlineButtons } from "./button-types.js";
import {
  isTelegramExecApprovalHandlerConfigured,
  shouldHandleTelegramExecApprovalRequest,
} from "./exec-approvals.js";
import { editMessageReplyMarkupTelegram, sendMessageTelegram, sendTypingTelegram } from "./send.js";

const log = createSubsystemLogger("telegram/approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
interface PendingMessage {
  chatId: string;
  messageId: string;
}
interface TelegramPendingDelivery {
  text: string;
  buttons: ReturnType<typeof resolveTelegramInlineButtons>;
}

export interface TelegramExecApprovalHandlerDeps {
  nowMs?: () => number;
  sendTyping?: typeof sendTypingTelegram;
  sendMessage?: typeof sendMessageTelegram;
  editReplyMarkup?: typeof editMessageReplyMarkupTelegram;
}

export interface TelegramApprovalHandlerContext {
  token: string;
  deps?: TelegramExecApprovalHandlerDeps;
}

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: TelegramApprovalHandlerContext;
} | null {
  const context = params.context as TelegramApprovalHandlerContext | undefined;
  const accountId = normalizeOptionalString(params.accountId) ?? "";
  if (!context?.token || !accountId) {
    return null;
  }
  return { accountId, context };
}

function buildPendingPayload(params: {
  request: ApprovalRequest;
  approvalKind: "exec" | "plugin";
  nowMs: number;
  view: PendingApprovalView;
}): TelegramPendingDelivery {
  const payload =
    params.approvalKind === "plugin"
      ? buildPluginApprovalPendingReplyPayload({
          nowMs: params.nowMs,
          request: params.request as PluginApprovalRequest,
        })
      : buildExecApprovalPendingReplyPayload({
          allowedDecisions: params.view.actions.map((action) => action.decision),
          approvalCommandId: params.request.id,
          approvalId: params.request.id,
          approvalSlug: params.request.id.slice(0, 8),
          command: params.view.approvalKind === "exec" ? params.view.commandText : "",
          cwd: params.view.approvalKind === "exec" ? (params.view.cwd ?? undefined) : undefined,
          expiresAtMs: params.request.expiresAtMs,
          host:
            params.view.approvalKind === "exec" && params.view.host === "node" ? "node" : "gateway",
          nodeId:
            params.view.approvalKind === "exec" ? (params.view.nodeId ?? undefined) : undefined,
          nowMs: params.nowMs,
        } satisfies ExecApprovalPendingReplyParams);
  return {
    buttons: resolveTelegramInlineButtons({
      interactive: buildApprovalInteractiveReplyFromActionDescriptors(params.view.actions),
    }),
    text: payload.text ?? "",
  };
}

export const telegramApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  TelegramPendingDelivery,
  { chatId: string; messageThreadId?: number },
  PendingMessage,
  never
>({
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? isTelegramExecApprovalHandlerConfigured({
            accountId: resolved.accountId,
            cfg: params.cfg,
          })
        : false;
    },
    shouldHandle: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? shouldHandleTelegramExecApprovalRequest({
            accountId: resolved.accountId,
            cfg: params.cfg,
            request: params.request,
          })
        : false;
    },
  },
  eventKinds: ["exec", "plugin"],
  interactions: {
    clearPendingActions: async ({ cfg, accountId, context, entry }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return;
      }
      const editReplyMarkup =
        resolved.context.deps?.editReplyMarkup ?? editMessageReplyMarkupTelegram;
      await editReplyMarkup(entry.chatId, entry.messageId, [], {
        accountId: resolved.accountId,
        cfg,
        token: resolved.context.token,
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`telegram approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
  presentation: {
    buildExpiredResult: () => ({ kind: "clear-actions" }),
    buildPendingPayload: ({ request, approvalKind, nowMs, view }) =>
      buildPendingPayload({ approvalKind, nowMs, request, view }),
    buildResolvedResult: () => ({ kind: "clear-actions" }),
  },
  transport: {
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return null;
      }
      const sendTyping = resolved.context.deps?.sendTyping ?? sendTypingTelegram;
      const sendMessage = resolved.context.deps?.sendMessage ?? sendMessageTelegram;
      await sendTyping(preparedTarget.chatId, {
        accountId: resolved.accountId,
        cfg,
        token: resolved.context.token,
        ...(preparedTarget.messageThreadId != null
          ? { messageThreadId: preparedTarget.messageThreadId }
          : {}),
      }).catch(() => {});
      const result = await sendMessage(preparedTarget.chatId, pendingPayload.text, {
        accountId: resolved.accountId,
        buttons: pendingPayload.buttons,
        cfg,
        token: resolved.context.token,
        ...(preparedTarget.messageThreadId != null
          ? { messageThreadId: preparedTarget.messageThreadId }
          : {}),
      });
      return {
        chatId: result.chatId,
        messageId: result.messageId,
      };
    },
    prepareTarget: ({ plannedTarget }) => ({
      dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
      target: {
        chatId: plannedTarget.target.to,
        messageThreadId:
          typeof plannedTarget.target.threadId === "number"
            ? plannedTarget.target.threadId
            : undefined,
      },
    }),
  },
});
