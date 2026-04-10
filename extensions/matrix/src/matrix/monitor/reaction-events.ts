import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { matrixApprovalCapability } from "../../approval-native.js";
import {
  resolveMatrixApprovalReactionTarget,
  unregisterMatrixApprovalReactionTarget,
} from "../../approval-reactions.js";
import { isApprovalNotFoundError, resolveMatrixApproval } from "../../exec-approval-resolver.js";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { extractMatrixReactionAnnotation } from "../reaction-common.js";
import type { MatrixClient } from "../sdk.js";
import { resolveMatrixInboundRoute } from "./route.js";
import type { PluginRuntime } from "./runtime-api.js";
import { resolveMatrixThreadRootId, resolveMatrixThreadRouting } from "./threads.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";

export type MatrixReactionNotificationMode = "off" | "own";

export function resolveMatrixReactionNotificationMode(params: {
  cfg: CoreConfig;
  accountId: string;
}): MatrixReactionNotificationMode {
  const matrixConfig = params.cfg.channels?.matrix;
  const accountConfig = resolveMatrixAccountConfig({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  return accountConfig.reactionNotifications ?? matrixConfig?.reactionNotifications ?? "own";
}

async function maybeResolveMatrixApprovalReaction(params: {
  cfg: CoreConfig;
  accountId: string;
  senderId: string;
  target: ReturnType<typeof resolveMatrixApprovalReactionTarget>;
  targetEventId: string;
  roomId: string;
  logVerboseMessage: (message: string) => void;
}): Promise<boolean> {
  if (!params.target) {
    return false;
  }
  if (
    !matrixApprovalCapability.authorizeActorAction?.({
      accountId: params.accountId,
      action: "approve",
      approvalKind: params.target.approvalId.startsWith("plugin:") ? "plugin" : "exec",
      cfg: params.cfg,
      senderId: params.senderId,
    })?.authorized
  ) {
    return false;
  }
  try {
    await resolveMatrixApproval({
      approvalId: params.target.approvalId,
      cfg: params.cfg,
      decision: params.target.decision,
      senderId: params.senderId,
    });
    params.logVerboseMessage(
      `matrix: approval reaction resolved id=${params.target.approvalId} sender=${params.senderId} decision=${params.target.decision}`,
    );
    return true;
  } catch (error) {
    if (isApprovalNotFoundError(error)) {
      unregisterMatrixApprovalReactionTarget({
        eventId: params.targetEventId,
        roomId: params.roomId,
      });
      params.logVerboseMessage(
        `matrix: approval reaction ignored for expired approval id=${params.target.approvalId} sender=${params.senderId}`,
      );
      return true;
    }
    params.logVerboseMessage(
      `matrix: approval reaction failed id=${params.target.approvalId} sender=${params.senderId}: ${String(error)}`,
    );
    return true;
  }
}

export async function handleInboundMatrixReaction(params: {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  event: MatrixRawEvent;
  senderId: string;
  senderLabel: string;
  selfUserId: string;
  isDirectMessage: boolean;
  logVerboseMessage: (message: string) => void;
}): Promise<void> {
  const reaction = extractMatrixReactionAnnotation(params.event.content);
  if (!reaction?.eventId) {
    return;
  }
  if (params.senderId === params.selfUserId) {
    return;
  }
  const approvalTarget = resolveMatrixApprovalReactionTarget({
    eventId: reaction.eventId,
    reactionKey: reaction.key,
    roomId: params.roomId,
  });
  if (
    await maybeResolveMatrixApprovalReaction({
      accountId: params.accountId,
      cfg: params.cfg,
      logVerboseMessage: params.logVerboseMessage,
      roomId: params.roomId,
      senderId: params.senderId,
      target: approvalTarget,
      targetEventId: reaction.eventId,
    })
  ) {
    return;
  }
  const notificationMode = resolveMatrixReactionNotificationMode({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  if (notificationMode === "off") {
    return;
  }

  const targetEvent = await params.client
    .getEvent(params.roomId, reaction.eventId)
    .catch((error) => {
      params.logVerboseMessage(
        `matrix: failed resolving reaction target room=${params.roomId} id=${reaction.eventId}: ${String(error)}`,
      );
      return null;
    });
  const targetSender =
    targetEvent && typeof targetEvent.sender === "string" ? targetEvent.sender.trim() : "";
  if (!targetSender) {
    return;
  }
  if (notificationMode === "own" && targetSender !== params.selfUserId) {
    return;
  }

  const targetContent =
    targetEvent && targetEvent.content && typeof targetEvent.content === "object"
      ? (targetEvent.content as RoomMessageEventContent)
      : undefined;
  const threadRootId = targetContent
    ? resolveMatrixThreadRootId({
        content: targetContent,
        event: targetEvent as MatrixRawEvent,
      })
    : undefined;
  const accountConfig = resolveMatrixAccountConfig({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  const thread = resolveMatrixThreadRouting({
    dmThreadReplies: accountConfig.dm?.threadReplies,
    isDirectMessage: params.isDirectMessage,
    messageId: reaction.eventId,
    threadReplies: accountConfig.threadReplies ?? "inbound",
    threadRootId,
  });
  const { route, runtimeBindingId } = resolveMatrixInboundRoute({
    accountId: params.accountId,
    cfg: params.cfg,
    dmSessionScope: accountConfig.dm?.sessionScope ?? "per-user",
    eventTs: params.event.origin_server_ts,
    isDirectMessage: params.isDirectMessage,
    resolveAgentRoute: params.core.channel.routing.resolveAgentRoute,
    roomId: params.roomId,
    senderId: params.senderId,
    threadId: thread.threadId,
  });
  if (runtimeBindingId) {
    getSessionBindingService().touch(runtimeBindingId, params.event.origin_server_ts);
  }
  const text = `Matrix reaction added: ${reaction.key} by ${params.senderLabel} on msg ${reaction.eventId}`;
  params.core.system.enqueueSystemEvent(text, {
    contextKey: `matrix:reaction:add:${params.roomId}:${reaction.eventId}:${params.senderId}:${reaction.key}`,
    sessionKey: route.sessionKey,
  });
  params.logVerboseMessage(
    `matrix: reaction event enqueued room=${params.roomId} target=${reaction.eventId} sender=${params.senderId} emoji=${reaction.key}`,
  );
}
