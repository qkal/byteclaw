import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../../../acp/runtime/session-identifiers.js";
import { readAcpSessionEntry } from "../../../acp/runtime/session-meta.js";
import { normalizeChatType } from "../../../channels/chat-type.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingPlacementForCurrentContext,
  resolveThreadBindingSpawnPolicy,
} from "../../../channels/thread-bindings-policy.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { resolveConversationBindingContextFromAcpCommand } from "../conversation-binding-input.js";
import { type SubagentsCommandContext, resolveFocusTargetSession, stopWithText } from "./shared.js";

interface FocusBindingContext {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  placement: "current" | "child";
}

function resolveFocusBindingContext(
  params: SubagentsCommandContext["params"],
): FocusBindingContext | null {
  const bindingContext = resolveConversationBindingContextFromAcpCommand(params);
  if (!bindingContext) {
    return null;
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  return {
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
    placement:
      chatType === "direct"
        ? "current"
        : resolveThreadBindingPlacementForCurrentContext({
            channel: bindingContext.channel,
            threadId: bindingContext.threadId || undefined,
          }),
  };
}

export async function handleSubagentsFocusAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params, runs, restTokens } = ctx;
  const token = restTokens.join(" ").trim();
  if (!token) {
    return stopWithText("Usage: /focus <subagent-label|session-key|session-id|session-label>");
  }

  const bindingContext = resolveFocusBindingContext(params);
  if (!bindingContext) {
    return stopWithText("⚠️ /focus must be run inside a bindable conversation.");
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    accountId: bindingContext.accountId,
    channel: bindingContext.channel,
  });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return stopWithText("⚠️ Conversation bindings are unavailable for this account.");
  }

  const focusTarget = await resolveFocusTargetSession({ runs, token });
  if (!focusTarget) {
    return stopWithText(`⚠️ Unable to resolve focus target: ${token}`);
  }

  if (bindingContext.placement === "child") {
    const spawnPolicy = resolveThreadBindingSpawnPolicy({
      accountId: bindingContext.accountId,
      cfg: params.cfg,
      channel: bindingContext.channel,
      kind: "subagent",
    });
    if (!spawnPolicy.enabled) {
      return stopWithText(
        `⚠️ ${formatThreadBindingDisabledError({
          accountId: spawnPolicy.accountId,
          channel: spawnPolicy.channel,
          kind: "subagent",
        })}`,
      );
    }
    if (bindingContext.placement === "child" && !spawnPolicy.spawnEnabled) {
      return stopWithText(
        `⚠️ ${formatThreadBindingSpawnDisabledError({
          accountId: spawnPolicy.accountId,
          channel: spawnPolicy.channel,
          kind: "subagent",
        })}`,
      );
    }
  }

  const senderId = normalizeOptionalString(params.command.senderId) ?? "";
  const existingBinding = bindingService.resolveByConversation({
    accountId: bindingContext.accountId,
    channel: bindingContext.channel,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId &&
    bindingContext.parentConversationId !== bindingContext.conversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  });
  const boundBy =
    typeof existingBinding?.metadata?.boundBy === "string"
      ? existingBinding.metadata.boundBy.trim()
      : "";
  if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    return stopWithText(`⚠️ Only ${boundBy} can refocus this conversation.`);
  }

  const label = focusTarget.label || token;
  const { accountId } = bindingContext;
  const acpMeta =
    focusTarget.targetKind === "acp"
      ? readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: focusTarget.targetSessionKey,
        })?.acp
      : undefined;
  if (!capabilities.placements.includes(bindingContext.placement)) {
    return stopWithText("⚠️ Conversation bindings are unavailable for this account.");
  }

  let binding;
  try {
    binding = await bindingService.bind({
      conversation: {
        accountId: bindingContext.accountId,
        channel: bindingContext.channel,
        conversationId: bindingContext.conversationId,
        ...(bindingContext.parentConversationId &&
        bindingContext.parentConversationId !== bindingContext.conversationId
          ? { parentConversationId: bindingContext.parentConversationId }
          : {}),
      },
      metadata: {
        agentId: focusTarget.agentId,
        boundBy: senderId || "unknown",
        introText: resolveThreadBindingIntroText({
          agentId: focusTarget.agentId,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
            cfg: params.cfg,
            channel: bindingContext.channel,
            accountId,
          }),
          label,
          maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
            cfg: params.cfg,
            channel: bindingContext.channel,
            accountId,
          }),
          sessionCwd: focusTarget.targetKind === "acp" ? resolveAcpSessionCwd(acpMeta) : undefined,
          sessionDetails:
            focusTarget.targetKind === "acp"
              ? resolveAcpThreadSessionDetailLines({
                  sessionKey: focusTarget.targetSessionKey,
                  meta: acpMeta,
                })
              : [],
        }),
        label,
        threadName: resolveThreadBindingThreadName({
          agentId: focusTarget.agentId,
          label,
        }),
      },
      placement: bindingContext.placement,
      targetKind: focusTarget.targetKind === "acp" ? "session" : "subagent",
      targetSessionKey: focusTarget.targetSessionKey,
    });
  } catch {
    return stopWithText("⚠️ Failed to bind this conversation to the target session.");
  }

  const actionText =
    bindingContext.placement === "child"
      ? `created child conversation ${binding.conversation.conversationId} and bound it to ${binding.targetSessionKey}`
      : `bound this conversation to ${binding.targetSessionKey}`;
  return stopWithText(`✅ ${actionText} (${focusTarget.targetKind}).`);
}
