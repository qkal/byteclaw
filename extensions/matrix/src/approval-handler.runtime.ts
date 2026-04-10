import type {
  ChannelApprovalCapabilityHandlerContext,
  PendingApprovalView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  type ExecApprovalReplyDecision,
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import { buildPluginApprovalResolvedReplyPayload } from "openclaw/plugin-sdk/approval-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildMatrixApprovalReactionHint,
  listMatrixApprovalReactionBindings,
  registerMatrixApprovalReactionTarget,
  unregisterMatrixApprovalReactionTarget,
} from "./approval-reactions.js";
import {
  isMatrixAnyApprovalClientEnabled,
  shouldHandleMatrixApprovalRequest,
} from "./exec-approvals.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { deleteMatrixMessage, editMatrixMessage } from "./matrix/actions/messages.js";
import { repairMatrixDirectRooms } from "./matrix/direct-management.js";
import type { MatrixClient } from "./matrix/sdk.js";
import { reactMatrixMessage, sendMessageMatrix } from "./matrix/send.js";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";
import type { CoreConfig } from "./types.js";

interface PendingMessage {
  roomId: string;
  messageIds: readonly string[];
  reactionEventId: string;
}
interface PreparedMatrixTarget {
  to: string;
  roomId: string;
  threadId?: string;
}
interface PendingApprovalContent {
  approvalId: string;
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}
interface ReactionTargetRef {
  roomId: string;
  eventId: string;
}
interface MatrixRawApprovalTarget {
  to: string;
  threadId?: string | number | null;
}
interface MatrixPrepareTargetParams {
  cfg: CoreConfig;
  accountId?: string | null;
  gatewayUrl?: string;
  context?: unknown;
  rawTarget: MatrixRawApprovalTarget;
}

export interface MatrixApprovalHandlerDeps {
  nowMs?: () => number;
  sendMessage?: typeof sendMessageMatrix;
  reactMessage?: typeof reactMatrixMessage;
  editMessage?: typeof editMatrixMessage;
  deleteMessage?: typeof deleteMatrixMessage;
  repairDirectRooms?: typeof repairMatrixDirectRooms;
}

export interface MatrixApprovalHandlerContext {
  client: MatrixClient;
  deps?: MatrixApprovalHandlerDeps;
}

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: MatrixApprovalHandlerContext;
} | null {
  const context = params.context as MatrixApprovalHandlerContext | undefined;
  const accountId = params.accountId?.trim() || "";
  if (!context?.client || !accountId) {
    return null;
  }
  return { accountId, context };
}

function normalizePendingMessageIds(entry: PendingMessage): string[] {
  return [...new Set(entry.messageIds.map((messageId) => messageId.trim()).filter(Boolean))];
}

function normalizeReactionTargetRef(params: ReactionTargetRef): ReactionTargetRef | null {
  const roomId = params.roomId.trim();
  const eventId = params.eventId.trim();
  if (!roomId || !eventId) {
    return null;
  }
  return { eventId, roomId };
}

function normalizeThreadId(value?: string | number | null): string | undefined {
  const trimmed = value == null ? "" : String(value).trim();
  return trimmed || undefined;
}

async function prepareTarget(
  params: MatrixPrepareTargetParams,
): Promise<PreparedMatrixTarget | null> {
  const resolved = resolveHandlerContext(params);
  if (!resolved) {
    return null;
  }
  const target = resolveMatrixTargetIdentity(params.rawTarget.to);
  if (!target) {
    return null;
  }
  const threadId = normalizeThreadId(params.rawTarget.threadId);
  if (target.kind === "user") {
    const account = resolveMatrixAccount({
      accountId: resolved.accountId,
      cfg: params.cfg,
    });
    const repairDirectRooms = resolved.context.deps?.repairDirectRooms ?? repairMatrixDirectRooms;
    const repaired = await repairDirectRooms({
      client: resolved.context.client,
      encrypted: account.config.encryption === true,
      remoteUserId: target.id,
    });
    if (!repaired.activeRoomId) {
      return null;
    }
    return {
      roomId: repaired.activeRoomId,
      threadId,
      to: `room:${repaired.activeRoomId}`,
    };
  }
  return {
    roomId: target.id,
    threadId,
    to: `room:${target.id}`,
  };
}

function buildPendingApprovalContent(params: {
  view: PendingApprovalView;
  nowMs: number;
}): PendingApprovalContent {
  const allowedDecisions = params.view.actions.map((action) => action.decision);
  const payload =
    params.view.approvalKind === "plugin"
      ? buildPluginApprovalPendingReplyPayload({
          allowedDecisions,
          nowMs: params.nowMs,
          request: {
            createdAtMs: 0,
            expiresAtMs: params.view.expiresAtMs,
            id: params.view.approvalId,
            request: {
              agentId: params.view.agentId ?? undefined,
              description: params.view.description ?? "",
              pluginId: params.view.pluginId ?? undefined,
              severity: params.view.severity,
              title: params.view.title,
              toolName: params.view.toolName ?? undefined,
            },
          } satisfies PluginApprovalRequest,
        })
      : buildExecApprovalPendingReplyPayload({
          agentId: params.view.agentId ?? undefined,
          allowedDecisions,
          approvalCommandId: params.view.approvalId,
          approvalId: params.view.approvalId,
          approvalSlug: params.view.approvalId.slice(0, 8),
          ask: params.view.ask ?? undefined,
          command: params.view.commandText,
          cwd: params.view.cwd ?? undefined,
          expiresAtMs: params.view.expiresAtMs,
          host: params.view.host === "node" ? "node" : "gateway",
          nodeId: params.view.nodeId ?? undefined,
          nowMs: params.nowMs,
          sessionKey: params.view.sessionKey ?? undefined,
        });
  const hint = buildMatrixApprovalReactionHint(allowedDecisions);
  const text = payload.text ?? "";
  return {
    allowedDecisions,
    approvalId: params.view.approvalId,
    text: hint ? (text ? `${hint}\n\n${text}` : hint) : text,
  };
}

function buildResolvedApprovalText(view: ResolvedApprovalView): string {
  if (view.approvalKind === "plugin") {
    return (
      buildPluginApprovalResolvedReplyPayload({
        resolved: {
          decision: view.decision,
          id: view.approvalId,
          resolvedBy: view.resolvedBy ?? undefined,
          ts: 0,
        },
      }).text ?? ""
    );
  }
  const decisionLabel =
    view.decision === "allow-once"
      ? "Allowed once"
      : view.decision === "allow-always"
        ? "Allowed always"
        : "Denied";
  return [
    `Exec approval: ${decisionLabel}`,
    "",
    "Command",
    buildMarkdownCodeBlock(view.commandText),
  ].join("\n");
}

function buildMarkdownCodeBlock(text: string): string {
  const longestFence = Math.max(...Array.from(text.matchAll(/`+/g), (match) => match[0].length), 0);
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return [fence, text, fence].join("\n");
}

export const matrixApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  PendingApprovalContent,
  PreparedMatrixTarget,
  PendingMessage,
  ReactionTargetRef,
  string
>({
  availability: {
    isConfigured: ({ cfg, accountId, context }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return false;
      }
      return isMatrixAnyApprovalClientEnabled({
        accountId: resolved.accountId,
        cfg,
      });
    },
    shouldHandle: ({ cfg, accountId, request, context }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return false;
      }
      return shouldHandleMatrixApprovalRequest({
        accountId: resolved.accountId,
        cfg,
        request: request as ExecApprovalRequest | PluginApprovalRequest,
      });
    },
  },
  eventKinds: ["exec", "plugin"],
  interactions: {
    bindPending: ({ entry, pendingPayload }) => {
      const target = normalizeReactionTargetRef({
        eventId: entry.reactionEventId,
        roomId: entry.roomId,
      });
      if (!target) {
        return null;
      }
      registerMatrixApprovalReactionTarget({
        allowedDecisions: pendingPayload.allowedDecisions,
        approvalId: pendingPayload.approvalId,
        eventId: target.eventId,
        roomId: target.roomId,
      });
      return target;
    },
    unbindPending: ({ binding }) => {
      const target = normalizeReactionTargetRef(binding);
      if (!target) {
        return;
      }
      unregisterMatrixApprovalReactionTarget(target);
    },
  },
  presentation: {
    buildExpiredResult: () => ({ kind: "delete" }),
    buildPendingPayload: ({ view, nowMs }) =>
      buildPendingApprovalContent({
        nowMs,
        view,
      }),
    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: buildResolvedApprovalText(view),
    }),
  },
  transport: {
    deleteEntry: async ({ cfg, accountId, context, entry, phase }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return;
      }
      const deleteMessage = resolved.context.deps?.deleteMessage ?? deleteMatrixMessage;
      await Promise.allSettled(
        normalizePendingMessageIds(entry).map(async (messageId) => {
          await deleteMessage(entry.roomId, messageId, {
            accountId: resolved.accountId,
            cfg: cfg as CoreConfig,
            client: resolved.context.client,
            reason: phase === "expired" ? "approval expired" : "approval resolved",
          });
        }),
      );
    },
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return null;
      }
      const sendMessage = resolved.context.deps?.sendMessage ?? sendMessageMatrix;
      const reactMessage = resolved.context.deps?.reactMessage ?? reactMatrixMessage;
      const result = await sendMessage(preparedTarget.to, pendingPayload.text, {
        accountId: resolved.accountId,
        cfg: cfg as CoreConfig,
        client: resolved.context.client,
        threadId: preparedTarget.threadId,
      });
      const messageIds = [
        ...new Set(
          (result.messageIds ?? [result.messageId])
            .map((messageId) => messageId.trim())
            .filter(Boolean),
        ),
      ];
      const reactionEventId =
        result.primaryMessageId?.trim() || messageIds[0] || result.messageId.trim();
      await Promise.allSettled(
        listMatrixApprovalReactionBindings(pendingPayload.allowedDecisions).map(
          async ({ emoji }) => {
            await reactMessage(result.roomId, reactionEventId, emoji, {
              accountId: resolved.accountId,
              cfg: cfg as CoreConfig,
              client: resolved.context.client,
            });
          },
        ),
      );
      return {
        messageIds,
        reactionEventId,
        roomId: result.roomId,
      };
    },
    prepareTarget: ({ cfg, accountId, context, plannedTarget }) =>
      prepareTarget({
        cfg,
        accountId,
        context,
        rawTarget: plannedTarget.target,
      }).then((preparedTarget) =>
        preparedTarget
          ? {
              dedupeKey: buildChannelApprovalNativeTargetKey({
                to: preparedTarget.roomId,
                threadId: preparedTarget.threadId,
              }),
              target: preparedTarget,
            }
          : null,
      ),
    updateEntry: async ({ cfg, accountId, context, entry, payload }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return;
      }
      const editMessage = resolved.context.deps?.editMessage ?? editMatrixMessage;
      const deleteMessage = resolved.context.deps?.deleteMessage ?? deleteMatrixMessage;
      const [primaryMessageId, ...staleMessageIds] = normalizePendingMessageIds(entry);
      if (!primaryMessageId) {
        return;
      }
      const text = payload;
      await Promise.allSettled([
        editMessage(entry.roomId, primaryMessageId, text, {
          accountId: resolved.accountId,
          cfg: cfg as CoreConfig,
          client: resolved.context.client,
        }),
        ...staleMessageIds.map(async (messageId) => {
          await deleteMessage(entry.roomId, messageId, {
            accountId: resolved.accountId,
            cfg: cfg as CoreConfig,
            client: resolved.context.client,
            reason: "approval resolved",
          });
        }),
      ]);
    },
  },
});
