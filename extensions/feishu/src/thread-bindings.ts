import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
  registerSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

type FeishuBindingTargetKind = "subagent" | "acp";

interface FeishuThreadBindingRecord {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  deliveryTo?: string;
  deliveryThreadId?: string;
  targetKind: FeishuBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
}

interface FeishuThreadBindingManager {
  accountId: string;
  getByConversationId: (conversationId: string) => FeishuThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => FeishuThreadBindingRecord[];
  bindConversation: (params: {
    conversationId: string;
    parentConversationId?: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => FeishuThreadBindingRecord | null;
  touchConversation: (conversationId: string, at?: number) => FeishuThreadBindingRecord | null;
  unbindConversation: (conversationId: string) => FeishuThreadBindingRecord | null;
  unbindBySessionKey: (targetSessionKey: string) => FeishuThreadBindingRecord[];
  stop: () => void;
}

interface FeishuThreadBindingsState {
  managersByAccountId: Map<string, FeishuThreadBindingManager>;
  bindingsByAccountConversation: Map<string, FeishuThreadBindingRecord>;
}

const FEISHU_THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.feishuThreadBindingsState");
let state: FeishuThreadBindingsState | undefined;

function getState(): FeishuThreadBindingsState {
  if (!state) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    state = (globalStore[FEISHU_THREAD_BINDINGS_STATE_KEY] as
      | FeishuThreadBindingsState
      | undefined) ?? {
      bindingsByAccountConversation: new Map(),
      managersByAccountId: new Map(),
    };
    globalStore[FEISHU_THREAD_BINDINGS_STATE_KEY] = state;
  }
  return state;
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function toSessionBindingTargetKind(raw: FeishuBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toFeishuTargetKind(raw: BindingTargetKind): FeishuBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function toSessionBindingRecord(
  record: FeishuThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const idleExpiresAt =
    defaults.idleTimeoutMs > 0 ? record.lastActivityAt + defaults.idleTimeoutMs : undefined;
  const maxAgeExpiresAt = defaults.maxAgeMs > 0 ? record.boundAt + defaults.maxAgeMs : undefined;
  const expiresAt =
    idleExpiresAt != null && maxAgeExpiresAt != null
      ? Math.min(idleExpiresAt, maxAgeExpiresAt)
      : (idleExpiresAt ?? maxAgeExpiresAt);
  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      conversationId: record.conversationId,
    }),
    boundAt: record.boundAt,
    conversation: {
      accountId: record.accountId,
      channel: "feishu",
      conversationId: record.conversationId,
      parentConversationId: record.parentConversationId,
    },
    expiresAt,
    metadata: {
      agentId: record.agentId,
      boundBy: record.boundBy,
      deliveryThreadId: record.deliveryThreadId,
      deliveryTo: record.deliveryTo,
      idleTimeoutMs: defaults.idleTimeoutMs,
      label: record.label,
      lastActivityAt: record.lastActivityAt,
      maxAgeMs: defaults.maxAgeMs,
    },
    status: "active",
    targetKind: toSessionBindingTargetKind(record.targetKind),
    targetSessionKey: record.targetSessionKey,
  };
}

export function createFeishuThreadBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): FeishuThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = getState().managersByAccountId.get(accountId);
  if (existing) {
    return existing;
  }

  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    accountId,
    cfg: params.cfg,
    channel: "feishu",
  });
  const maxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    accountId,
    cfg: params.cfg,
    channel: "feishu",
  });

  const manager: FeishuThreadBindingManager = {
    accountId,
    bindConversation: ({
      conversationId,
      parentConversationId,
      targetKind,
      targetSessionKey,
      metadata,
    }) => {
      const normalizedConversationId = conversationId.trim();
      if (!normalizedConversationId || !targetSessionKey.trim()) {
        return null;
      }
      const now = Date.now();
      const record: FeishuThreadBindingRecord = {
        accountId,
        agentId:
          typeof metadata?.agentId === "string" && metadata.agentId.trim()
            ? metadata.agentId.trim()
            : resolveAgentIdFromSessionKey(targetSessionKey),
        boundAt: now,
        boundBy:
          typeof metadata?.boundBy === "string" && metadata.boundBy.trim()
            ? metadata.boundBy.trim()
            : undefined,
        conversationId: normalizedConversationId,
        deliveryThreadId:
          typeof metadata?.deliveryThreadId === "string" && metadata.deliveryThreadId.trim()
            ? metadata.deliveryThreadId.trim()
            : undefined,
        deliveryTo:
          typeof metadata?.deliveryTo === "string" && metadata.deliveryTo.trim()
            ? metadata.deliveryTo.trim()
            : undefined,
        label:
          typeof metadata?.label === "string" && metadata.label.trim()
            ? metadata.label.trim()
            : undefined,
        lastActivityAt: now,
        parentConversationId: normalizeOptionalString(parentConversationId),
        targetKind: toFeishuTargetKind(targetKind),
        targetSessionKey: targetSessionKey.trim(),
      };
      getState().bindingsByAccountConversation.set(
        resolveBindingKey({ accountId, conversationId: normalizedConversationId }),
        record,
      );
      return record;
    },
    getByConversationId: (conversationId) =>
      getState().bindingsByAccountConversation.get(
        resolveBindingKey({ accountId, conversationId }),
      ),
    listBySessionKey: (targetSessionKey) =>
      [...getState().bindingsByAccountConversation.values()].filter(
        (record) => record.accountId === accountId && record.targetSessionKey === targetSessionKey,
      ),
    stop: () => {
      for (const key of getState().bindingsByAccountConversation.keys()) {
        if (key.startsWith(`${accountId}:`)) {
          getState().bindingsByAccountConversation.delete(key);
        }
      }
      getState().managersByAccountId.delete(accountId);
      unregisterSessionBindingAdapter({
        accountId,
        adapter: sessionBindingAdapter,
        channel: "feishu",
      });
    },
    touchConversation: (conversationId, at = Date.now()) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = getState().bindingsByAccountConversation.get(key);
      if (!existingRecord) {
        return null;
      }
      const updated = { ...existingRecord, lastActivityAt: at };
      getState().bindingsByAccountConversation.set(key, updated);
      return updated;
    },
    unbindBySessionKey: (targetSessionKey) => {
      const removed: FeishuThreadBindingRecord[] = [];
      for (const record of getState().bindingsByAccountConversation.values()) {
        if (record.accountId !== accountId || record.targetSessionKey !== targetSessionKey) {
          continue;
        }
        getState().bindingsByAccountConversation.delete(
          resolveBindingKey({ accountId, conversationId: record.conversationId }),
        );
        removed.push(record);
      }
      return removed;
    },
    unbindConversation: (conversationId) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = getState().bindingsByAccountConversation.get(key);
      if (!existingRecord) {
        return null;
      }
      getState().bindingsByAccountConversation.delete(key);
      return existingRecord;
    },
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    accountId,
    bind: async (input) => {
      if (input.conversation.channel !== "feishu" || input.placement === "child") {
        return null;
      }
      const bound = manager.bindConversation({
        conversationId: input.conversation.conversationId,
        metadata: input.metadata,
        parentConversationId: input.conversation.parentConversationId,
        targetKind: input.targetKind,
        targetSessionKey: input.targetSessionKey,
      });
      return bound ? toSessionBindingRecord(bound, { idleTimeoutMs, maxAgeMs }) : null;
    },
    capabilities: {
      placements: ["current"],
    },
    channel: "feishu",
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs })),
    resolveByConversation: (ref) => {
      if (ref.channel !== "feishu") {
        return null;
      }
      const found = manager.getByConversationId(ref.conversationId);
      return found ? toSessionBindingRecord(found, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (conversationId) {
        manager.touchConversation(conversationId, at);
      }
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        return manager
          .unbindBySessionKey(input.targetSessionKey.trim())
          .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = manager.unbindConversation(conversationId);
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  getState().managersByAccountId.set(accountId, manager);
  return manager;
}

export function getFeishuThreadBindingManager(
  accountId?: string,
): FeishuThreadBindingManager | null {
  return getState().managersByAccountId.get(normalizeAccountId(accountId)) ?? null;
}

export const __testing = {
  resetFeishuThreadBindingsForTests() {
    for (const manager of getState().managersByAccountId.values()) {
      manager.stop();
    }
    getState().managersByAccountId.clear();
    getState().bindingsByAccountConversation.clear();
  },
};
