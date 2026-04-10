import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { buildFeishuConversationId, parseFeishuConversationId } from "./conversation-id.js";
import { normalizeFeishuTarget } from "./targets.js";
import { getFeishuThreadBindingManager } from "./thread-bindings.js";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(feishu|lark):/i, "").trim();
}

function resolveFeishuRequesterConversation(params: {
  accountId?: string;
  to?: string;
  threadId?: string | number;
  requesterSessionKey?: string;
}): {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
} | null {
  const manager = getFeishuThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }
  const rawTo = params.to?.trim();
  const withoutProviderPrefix = rawTo ? stripProviderPrefix(rawTo) : "";
  const normalizedTarget = rawTo ? normalizeFeishuTarget(rawTo) : null;
  const threadId =
    params.threadId != null && params.threadId !== "" ? String(params.threadId).trim() : "";
  const isChatTarget = /^(chat|group|channel):/i.test(withoutProviderPrefix);
  const parsedRequesterTopic =
    normalizedTarget && threadId && isChatTarget
      ? parseFeishuConversationId({
          conversationId: buildFeishuConversationId({
            chatId: normalizedTarget,
            scope: "group_topic",
            topicId: threadId,
          }),
          parentConversationId: normalizedTarget,
        })
      : null;
  const requesterSessionKey = params.requesterSessionKey?.trim();
  if (requesterSessionKey) {
    const existingBindings = manager.listBySessionKey(requesterSessionKey);
    if (existingBindings.length === 1) {
      const existing = existingBindings[0];
      return {
        accountId: existing.accountId,
        conversationId: existing.conversationId,
        parentConversationId: existing.parentConversationId,
      };
    }
    if (existingBindings.length > 1) {
      if (rawTo && normalizedTarget && !threadId && !isChatTarget) {
        const directMatches = existingBindings.filter(
          (entry) =>
            entry.accountId === manager.accountId &&
            entry.conversationId === normalizedTarget &&
            !entry.parentConversationId,
        );
        if (directMatches.length === 1) {
          const existing = directMatches[0];
          return {
            accountId: existing.accountId,
            conversationId: existing.conversationId,
            parentConversationId: existing.parentConversationId,
          };
        }
        return null;
      }
      if (parsedRequesterTopic) {
        const matchingTopicBindings = existingBindings.filter((entry) => {
          const parsed = parseFeishuConversationId({
            conversationId: entry.conversationId,
            parentConversationId: entry.parentConversationId,
          });
          return (
            parsed?.chatId === parsedRequesterTopic.chatId &&
            parsed?.topicId === parsedRequesterTopic.topicId
          );
        });
        if (matchingTopicBindings.length === 1) {
          const existing = matchingTopicBindings[0];
          return {
            accountId: existing.accountId,
            conversationId: existing.conversationId,
            parentConversationId: existing.parentConversationId,
          };
        }
        const senderScopedTopicBindings = matchingTopicBindings.filter((entry) => {
          const parsed = parseFeishuConversationId({
            conversationId: entry.conversationId,
            parentConversationId: entry.parentConversationId,
          });
          return parsed?.scope === "group_topic_sender";
        });
        if (
          senderScopedTopicBindings.length === 1 &&
          matchingTopicBindings.length === senderScopedTopicBindings.length
        ) {
          const existing = senderScopedTopicBindings[0];
          return {
            accountId: existing.accountId,
            conversationId: existing.conversationId,
            parentConversationId: existing.parentConversationId,
          };
        }
        return null;
      }
    }
  }

  if (!rawTo) {
    return null;
  }
  if (!normalizedTarget) {
    return null;
  }

  if (threadId) {
    if (!isChatTarget) {
      return null;
    }
    return {
      accountId: manager.accountId,
      conversationId: buildFeishuConversationId({
        chatId: normalizedTarget,
        scope: "group_topic",
        topicId: threadId,
      }),
      parentConversationId: normalizedTarget,
    };
  }

  if (isChatTarget) {
    return null;
  }

  return {
    accountId: manager.accountId,
    conversationId: normalizedTarget,
  };
}

function resolveFeishuDeliveryOrigin(params: {
  conversationId: string;
  parentConversationId?: string;
  accountId: string;
  deliveryTo?: string;
  deliveryThreadId?: string;
}): {
  channel: "feishu";
  accountId: string;
  to: string;
  threadId?: string;
} {
  const deliveryTo = params.deliveryTo?.trim();
  const deliveryThreadId = params.deliveryThreadId?.trim();
  if (deliveryTo) {
    return {
      accountId: params.accountId,
      channel: "feishu",
      to: deliveryTo,
      ...(deliveryThreadId ? { threadId: deliveryThreadId } : {}),
    };
  }
  const parsed = parseFeishuConversationId({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (parsed?.topicId) {
    return {
      accountId: params.accountId,
      channel: "feishu",
      threadId: parsed.topicId,
      to: `chat:${params.parentConversationId?.trim() || parsed.chatId}`,
    };
  }
  return {
    accountId: params.accountId,
    channel: "feishu",
    to: `user:${params.conversationId}`,
  };
}

function resolveMatchingChildBinding(params: {
  accountId?: string;
  childSessionKey: string;
  requesterSessionKey?: string;
  requesterOrigin?: {
    to?: string;
    threadId?: string | number;
  };
}) {
  const manager = getFeishuThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }
  const childBindings = manager.listBySessionKey(params.childSessionKey.trim());
  if (childBindings.length === 0) {
    return null;
  }

  const requesterConversation = resolveFeishuRequesterConversation({
    accountId: manager.accountId,
    requesterSessionKey: params.requesterSessionKey,
    threadId: params.requesterOrigin?.threadId,
    to: params.requesterOrigin?.to,
  });
  if (requesterConversation) {
    const matched = childBindings.find(
      (entry) =>
        entry.accountId === requesterConversation.accountId &&
        entry.conversationId === requesterConversation.conversationId &&
        normalizeOptionalString(entry.parentConversationId) ===
          normalizeOptionalString(requesterConversation.parentConversationId),
    );
    if (matched) {
      return matched;
    }
  }

  return childBindings.length === 1 ? childBindings[0] : null;
}

interface FeishuSubagentContext {
  requesterSessionKey?: string;
}

interface FeishuSubagentSpawningEvent {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId?: string;
  label?: string;
}

interface FeishuSubagentDeliveryTargetEvent {
  expectsCompletionMessage?: boolean;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  requesterSessionKey?: string;
}

interface FeishuSubagentEndedEvent {
  accountId?: string;
  targetSessionKey: string;
}

export async function handleFeishuSubagentSpawning(
  event: FeishuSubagentSpawningEvent,
  ctx: FeishuSubagentContext,
) {
  if (!event.threadRequested) {
    return;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requester?.channel);
  if (requesterChannel !== "feishu") {
    return;
  }

  const manager = getFeishuThreadBindingManager(event.requester?.accountId);
  if (!manager) {
    return {
      error:
        "Feishu current-conversation binding is unavailable because the Feishu account monitor is not active.",
      status: "error" as const,
    };
  }

  const conversation = resolveFeishuRequesterConversation({
    accountId: event.requester?.accountId,
    requesterSessionKey: ctx.requesterSessionKey,
    threadId: event.requester?.threadId,
    to: event.requester?.to,
  });
  if (!conversation) {
    return {
      error:
        "Feishu current-conversation binding is only available in direct messages or topic conversations.",
      status: "error" as const,
    };
  }

  try {
    const binding = manager.bindConversation({
      conversationId: conversation.conversationId,
      metadata: {
        agentId: event.agentId,
        boundBy: "system",
        deliveryThreadId:
          event.requester?.threadId != null && event.requester.threadId !== ""
            ? String(event.requester.threadId)
            : undefined,
        deliveryTo: event.requester?.to,
        label: event.label,
      },
      parentConversationId: conversation.parentConversationId,
      targetKind: "subagent",
      targetSessionKey: event.childSessionKey,
    });
    if (!binding) {
      return {
        error:
          "Unable to bind this Feishu conversation to the spawned subagent session. Session mode is unavailable for this target.",
        status: "error" as const,
      };
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  } catch (error) {
    return {
      error: `Feishu conversation bind failed: ${summarizeError(error)}`,
      status: "error" as const,
    };
  }
}

export function handleFeishuSubagentDeliveryTarget(event: FeishuSubagentDeliveryTargetEvent) {
  if (!event.expectsCompletionMessage) {
    return;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requesterOrigin?.channel);
  if (requesterChannel !== "feishu") {
    return;
  }

  const binding = resolveMatchingChildBinding({
    accountId: event.requesterOrigin?.accountId,
    childSessionKey: event.childSessionKey,
    requesterOrigin: {
      threadId: event.requesterOrigin?.threadId,
      to: event.requesterOrigin?.to,
    },
    requesterSessionKey: event.requesterSessionKey,
  });
  if (!binding) {
    return;
  }

  return {
    origin: resolveFeishuDeliveryOrigin({
      accountId: binding.accountId,
      conversationId: binding.conversationId,
      deliveryThreadId: binding.deliveryThreadId,
      deliveryTo: binding.deliveryTo,
      parentConversationId: binding.parentConversationId,
    }),
  };
}

export function handleFeishuSubagentEnded(event: FeishuSubagentEndedEvent) {
  const manager = getFeishuThreadBindingManager(event.accountId);
  manager?.unbindBySessionKey(event.targetSessionKey);
}

export function registerFeishuSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", (event, ctx) => handleFeishuSubagentSpawning(event, ctx));
  api.on("subagent_delivery_target", (event) => handleFeishuSubagentDeliveryTarget(event));
  api.on("subagent_ended", (event) => handleFeishuSubagentEnded(event));
}
