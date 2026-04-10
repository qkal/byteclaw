import { Routes } from "discord-api-types/v10";
import {
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
  registerSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import {
  type OpenClawConfig,
  getRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { createDiscordRestClient } from "../client.js";
import {
  createThreadForBinding,
  createWebhookForChannel,
  findReusableWebhook,
  isDiscordThreadGoneError,
  isThreadArchived,
  maybeSendBindingMessage,
  resolveChannelIdForBinding,
  summarizeDiscordError,
} from "./thread-bindings.discord-api.js";
import {
  resolveThreadBindingFarewellText,
  resolveThreadBindingThreadName,
} from "./thread-bindings.messages.js";
import {
  BINDINGS_BY_THREAD_ID,
  MANAGERS_BY_ACCOUNT_ID,
  PERSIST_BY_ACCOUNT_ID,
  THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
  ensureBindingsLoaded,
  forgetThreadBindingToken,
  getThreadBindingToken,
  normalizeTargetKind,
  normalizeThreadBindingDurationMs,
  normalizeThreadId,
  rememberRecentUnboundWebhookEcho,
  rememberThreadBindingToken,
  removeBindingRecord,
  resetThreadBindingsForTests,
  resolveBindingIdsForSession,
  resolveBindingRecordKey,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingsPath,
  saveBindingsToDisk,
  setBindingRecord,
  shouldDefaultPersist,
} from "./thread-bindings.state.js";
import {
  DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  THREAD_BINDINGS_SWEEP_INTERVAL_MS,
  type ThreadBindingManager,
  type ThreadBindingRecord,
} from "./thread-bindings.types.js";

function registerManager(manager: ThreadBindingManager) {
  MANAGERS_BY_ACCOUNT_ID.set(manager.accountId, manager);
}

function unregisterManager(accountId: string, manager: ThreadBindingManager) {
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing === manager) {
    MANAGERS_BY_ACCOUNT_ID.delete(accountId);
  }
}

const SWEEPERS_BY_ACCOUNT_ID = new Map<string, () => Promise<void>>();

function resolveEffectiveBindingExpiresAt(params: {
  record: ThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
    defaultIdleTimeoutMs: params.defaultIdleTimeoutMs,
    record: params.record,
  });
  const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
    defaultMaxAgeMs: params.defaultMaxAgeMs,
    record: params.record,
  });
  if (inactivityExpiresAt != null && maxAgeExpiresAt != null) {
    return Math.min(inactivityExpiresAt, maxAgeExpiresAt);
  }
  return inactivityExpiresAt ?? maxAgeExpiresAt;
}

function createNoopManager(accountIdRaw?: string): ThreadBindingManager {
  const accountId = normalizeAccountId(accountIdRaw);
  return {
    accountId,
    bindTarget: async () => null,
    getBySessionKey: () => undefined,
    getByThreadId: () => undefined,
    getIdleTimeoutMs: () => DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
    getMaxAgeMs: () => DEFAULT_THREAD_BINDING_MAX_AGE_MS,
    listBindings: () => [],
    listBySessionKey: () => [],
    stop: () => {},
    touchThread: () => null,
    unbindBySessionKey: () => [],
    unbindThread: () => null,
  };
}

function toSessionBindingTargetKind(raw: string): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toThreadBindingTargetKind(raw: BindingTargetKind): "subagent" | "acp" {
  return raw === "subagent" ? "subagent" : "acp";
}

function isDirectConversationBindingId(value?: string | null): boolean {
  const trimmed = normalizeOptionalString(value);
  return Boolean(trimmed && /^(user:|channel:)/i.test(trimmed));
}

function toSessionBindingRecord(
  record: ThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const bindingId =
    resolveBindingRecordKey({
      accountId: record.accountId,
      threadId: record.threadId,
    }) ?? `${record.accountId}:${record.threadId}`;
  return {
    bindingId,
    boundAt: record.boundAt,
    conversation: {
      accountId: record.accountId,
      channel: "discord",
      conversationId: record.threadId,
      parentConversationId: record.channelId,
    },
    expiresAt: resolveEffectiveBindingExpiresAt({
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
      record,
    }),
    metadata: {
      agentId: record.agentId,
      boundBy: record.boundBy,
      idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
        defaultIdleTimeoutMs: defaults.idleTimeoutMs,
        record,
      }),
      label: record.label,
      lastActivityAt: record.lastActivityAt,
      maxAgeMs: resolveThreadBindingMaxAgeMs({
        defaultMaxAgeMs: defaults.maxAgeMs,
        record,
      }),
      webhookId: record.webhookId,
      webhookToken: record.webhookToken,
      ...record.metadata,
    },
    status: "active",
    targetKind: toSessionBindingTargetKind(record.targetKind),
    targetSessionKey: record.targetSessionKey,
  };
}

export function createThreadBindingManager(
  params: {
    accountId?: string;
    token?: string;
    cfg?: OpenClawConfig;
    persist?: boolean;
    enableSweeper?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  } = {},
): ThreadBindingManager {
  ensureBindingsLoaded();
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    rememberThreadBindingToken({ accountId, token: params.token });
    return existing;
  }

  rememberThreadBindingToken({ accountId, token: params.token });

  const persist = params.persist ?? shouldDefaultPersist();
  PERSIST_BY_ACCOUNT_ID.set(accountId, persist);
  const idleTimeoutMs = normalizeThreadBindingDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeThreadBindingDurationMs(
    params.maxAgeMs,
    DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  );
  const resolveCurrentCfg = () => getRuntimeConfigSnapshot() ?? params.cfg;
  const resolveCurrentToken = () => getThreadBindingToken(accountId) ?? params.token;

  let sweepTimer: NodeJS.Timeout | null = null;
  const runSweepOnce = async () => {
    const bindings = manager.listBindings();
    if (bindings.length === 0) {
      return;
    }
    let rest: ReturnType<typeof createDiscordRestClient>["rest"] | null = null;
    for (const snapshotBinding of bindings) {
      // Re-read live state after any awaited work from earlier iterations.
      // This avoids unbinding based on stale snapshot data when activity touches
      // Happen while the sweeper loop is in-flight.
      const binding = manager.getByThreadId(snapshotBinding.threadId);
      if (!binding) {
        continue;
      }
      const now = Date.now();
      const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
        defaultIdleTimeoutMs: idleTimeoutMs,
        record: binding,
      });
      const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
        defaultMaxAgeMs: maxAgeMs,
        record: binding,
      });
      const expirationCandidates: {
        reason: "idle-expired" | "max-age-expired";
        at: number;
      }[] = [];
      if (inactivityExpiresAt != null && now >= inactivityExpiresAt) {
        expirationCandidates.push({ at: inactivityExpiresAt, reason: "idle-expired" });
      }
      if (maxAgeExpiresAt != null && now >= maxAgeExpiresAt) {
        expirationCandidates.push({ at: maxAgeExpiresAt, reason: "max-age-expired" });
      }
      if (expirationCandidates.length > 0) {
        expirationCandidates.sort((a, b) => a.at - b.at);
        const reason = expirationCandidates[0]?.reason ?? "idle-expired";
        manager.unbindThread({
          farewellText: resolveThreadBindingFarewellText({
            idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
              record: binding,
              defaultIdleTimeoutMs: idleTimeoutMs,
            }),
            maxAgeMs: resolveThreadBindingMaxAgeMs({
              record: binding,
              defaultMaxAgeMs: maxAgeMs,
            }),
            reason,
          }),
          reason,
          sendFarewell: true,
          threadId: binding.threadId,
        });
        continue;
      }
      if (isDirectConversationBindingId(binding.threadId)) {
        continue;
      }
      if (!rest) {
        try {
          const cfg = resolveCurrentCfg();
          ({ rest } = createDiscordRestClient(
            {
              accountId,
              token: resolveCurrentToken(),
            },
            cfg,
          ));
        } catch {
          return;
        }
      }
      try {
        const channel = await rest.get(Routes.channel(binding.threadId));
        if (!channel || typeof channel !== "object") {
          logVerbose(
            `discord thread binding sweep probe returned invalid payload for ${binding.threadId}`,
          );
          continue;
        }
        if (isThreadArchived(channel)) {
          manager.unbindThread({
            reason: "thread-archived",
            sendFarewell: true,
            threadId: binding.threadId,
          });
        }
      } catch (error) {
        if (isDiscordThreadGoneError(error)) {
          logVerbose(
            `discord thread binding sweep removing stale binding ${binding.threadId}: ${summarizeDiscordError(error)}`,
          );
          manager.unbindThread({
            reason: "thread-delete",
            sendFarewell: false,
            threadId: binding.threadId,
          });
          continue;
        }
        logVerbose(
          `discord thread binding sweep probe failed for ${binding.threadId}: ${summarizeDiscordError(error)}`,
        );
      }
    }
  };
  SWEEPERS_BY_ACCOUNT_ID.set(accountId, runSweepOnce);

  const manager: ThreadBindingManager = {
    accountId,
    bindTarget: async (bindParams) => {
      const cfg = resolveCurrentCfg();
      let threadId = normalizeThreadId(bindParams.threadId);
      let channelId = normalizeOptionalString(bindParams.channelId) ?? "";
      const directConversationBinding =
        isDirectConversationBindingId(threadId) || isDirectConversationBindingId(channelId);

      if (!threadId && bindParams.createThread) {
        if (!channelId) {
          return null;
        }
        const threadName = resolveThreadBindingThreadName({
          agentId: bindParams.agentId,
          label: bindParams.label,
        });
        threadId =
          (await createThreadForBinding({
            accountId,
            cfg,
            channelId,
            threadName: normalizeOptionalString(bindParams.threadName) ?? threadName,
            token: resolveCurrentToken(),
          })) ?? undefined;
      }

      if (!threadId) {
        return null;
      }

      if (!channelId && directConversationBinding) {
        channelId = threadId;
      }

      if (!channelId) {
        channelId =
          (await resolveChannelIdForBinding({
            accountId,
            cfg,
            channelId: bindParams.channelId,
            threadId,
            token: resolveCurrentToken(),
          })) ?? "";
      }
      if (!channelId) {
        return null;
      }

      const targetSessionKey = normalizeOptionalString(bindParams.targetSessionKey) ?? "";
      if (!targetSessionKey) {
        return null;
      }

      const targetKind = normalizeTargetKind(bindParams.targetKind, targetSessionKey);
      let webhookId = normalizeOptionalString(bindParams.webhookId) ?? "";
      let webhookToken = normalizeOptionalString(bindParams.webhookToken) ?? "";
      if (!directConversationBinding && (!webhookId || !webhookToken)) {
        const cachedWebhook = findReusableWebhook({ accountId, channelId });
        webhookId = cachedWebhook.webhookId ?? "";
        webhookToken = cachedWebhook.webhookToken ?? "";
      }
      if (!directConversationBinding && (!webhookId || !webhookToken)) {
        const createdWebhook = await createWebhookForChannel({
          accountId,
          cfg,
          channelId,
          token: resolveCurrentToken(),
        });
        webhookId = createdWebhook.webhookId ?? "";
        webhookToken = createdWebhook.webhookToken ?? "";
      }

      const now = Date.now();
      const record: ThreadBindingRecord = {
        accountId,
        agentId:
          normalizeOptionalString(bindParams.agentId) ??
          resolveAgentIdFromSessionKey(targetSessionKey),
        boundAt: now,
        boundBy: normalizeOptionalString(bindParams.boundBy) || "system",
        channelId,
        idleTimeoutMs,
        label: normalizeOptionalString(bindParams.label),
        lastActivityAt: now,
        maxAgeMs,
        metadata:
          bindParams.metadata && typeof bindParams.metadata === "object"
            ? { ...bindParams.metadata }
            : undefined,
        targetKind,
        targetSessionKey,
        threadId,
        webhookId: webhookId || undefined,
        webhookToken: webhookToken || undefined,
      };

      setBindingRecord(record);
      if (persist) {
        saveBindingsToDisk();
      }

      const introText = bindParams.introText?.trim();
      if (introText) {
        void maybeSendBindingMessage({ cfg, record, text: introText });
      }
      return record;
    },
    getBySessionKey: (targetSessionKey) => {
      const all = manager.listBySessionKey(targetSessionKey);
      return all[0];
    },
    getByThreadId: (threadId) => {
      const key = resolveBindingRecordKey({
        accountId,
        threadId,
      });
      if (!key) {
        return undefined;
      }
      const entry = BINDINGS_BY_THREAD_ID.get(key);
      if (!entry || entry.accountId !== accountId) {
        return undefined;
      }
      return entry;
    },
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    listBindings: () =>
      [...BINDINGS_BY_THREAD_ID.values()].filter((entry) => entry.accountId === accountId),
    listBySessionKey: (targetSessionKey) => {
      const ids = resolveBindingIdsForSession({
        accountId,
        targetSessionKey,
      });
      return ids
        .map((bindingKey) => BINDINGS_BY_THREAD_ID.get(bindingKey))
        .filter((entry): entry is ThreadBindingRecord => Boolean(entry));
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      SWEEPERS_BY_ACCOUNT_ID.delete(accountId);
      unregisterManager(accountId, manager);
      unregisterSessionBindingAdapter({
        accountId,
        adapter: sessionBindingAdapter,
        channel: "discord",
      });
      forgetThreadBindingToken(accountId);
    },
    touchThread: (touchParams) => {
      const key = resolveBindingRecordKey({
        accountId,
        threadId: touchParams.threadId,
      });
      if (!key) {
        return null;
      }
      const existing = BINDINGS_BY_THREAD_ID.get(key);
      if (!existing || existing.accountId !== accountId) {
        return null;
      }
      const now = Date.now();
      const at =
        typeof touchParams.at === "number" && Number.isFinite(touchParams.at)
          ? Math.max(0, Math.floor(touchParams.at))
          : now;
      const nextRecord: ThreadBindingRecord = {
        ...existing,
        lastActivityAt: Math.max(existing.lastActivityAt || 0, at),
      };
      setBindingRecord(nextRecord);
      if (touchParams.persist ?? persist) {
        saveBindingsToDisk({
          minIntervalMs: THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
        });
      }
      return nextRecord;
    },
    unbindBySessionKey: (unbindParams) => {
      const ids = resolveBindingIdsForSession({
        accountId,
        targetKind: unbindParams.targetKind,
        targetSessionKey: unbindParams.targetSessionKey,
      });
      if (ids.length === 0) {
        return [];
      }
      const removed: ThreadBindingRecord[] = [];
      for (const bindingKey of ids) {
        const binding = BINDINGS_BY_THREAD_ID.get(bindingKey);
        if (!binding) {
          continue;
        }
        const entry = manager.unbindThread({
          farewellText: unbindParams.farewellText,
          reason: unbindParams.reason,
          sendFarewell: unbindParams.sendFarewell,
          threadId: binding.threadId,
        });
        if (entry) {
          removed.push(entry);
        }
      }
      return removed;
    },
    unbindThread: (unbindParams) => {
      const bindingKey = resolveBindingRecordKey({
        accountId,
        threadId: unbindParams.threadId,
      });
      if (!bindingKey) {
        return null;
      }
      const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
      if (!existing || existing.accountId !== accountId) {
        return null;
      }
      const removed = removeBindingRecord(bindingKey);
      if (!removed) {
        return null;
      }
      rememberRecentUnboundWebhookEcho(removed);
      if (persist) {
        saveBindingsToDisk();
      }
      if (unbindParams.sendFarewell !== false) {
        const cfg = resolveCurrentCfg();
        const farewell = resolveThreadBindingFarewellText({
          farewellText: unbindParams.farewellText,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
            record: removed,
            defaultIdleTimeoutMs: idleTimeoutMs,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMs({
            record: removed,
            defaultMaxAgeMs: maxAgeMs,
          }),
          reason: unbindParams.reason,
        });
        // Use bot send path for farewell messages so unbound threads don't process
        // Webhook echoes as fresh inbound turns when allowBots is enabled.
        void maybeSendBindingMessage({
          cfg,
          preferWebhook: false,
          record: removed,
          text: farewell,
        });
      }
      return removed;
    },
  };

  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      void runSweepOnce();
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    // Keep the production process free to exit, but avoid breaking fake-timer
    // Sweeper tests where unref'd intervals may never fire.
    if (!(process.env.VITEST || process.env.NODE_ENV === "test")) {
      sweepTimer.unref?.();
    }
  }

  const sessionBindingAdapter: SessionBindingAdapter = {
    accountId,
    bind: async (input) => {
      if (input.conversation.channel !== "discord") {
        return null;
      }
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      const conversationId = normalizeOptionalString(input.conversation.conversationId) ?? "";
      const placement = input.placement === "child" ? "child" : "current";
      const metadata = input.metadata ?? {};
      const label = normalizeOptionalString(metadata.label);
      const threadName =
        typeof metadata.threadName === "string"
          ? normalizeOptionalString(metadata.threadName)
          : undefined;
      const introText =
        typeof metadata.introText === "string"
          ? normalizeOptionalString(metadata.introText)
          : undefined;
      const boundBy =
        typeof metadata.boundBy === "string"
          ? normalizeOptionalString(metadata.boundBy)
          : undefined;
      const agentId =
        typeof metadata.agentId === "string"
          ? normalizeOptionalString(metadata.agentId)
          : undefined;
      let threadId: string | undefined;
      let channelId = normalizeOptionalString(input.conversation.parentConversationId);
      let createThread = false;

      if (placement === "child") {
        createThread = true;
        if (!channelId && conversationId) {
          const cfg = resolveCurrentCfg();
          channelId =
            (await resolveChannelIdForBinding({
              accountId,
              cfg,
              threadId: conversationId,
              token: resolveCurrentToken(),
            })) ?? undefined;
        }
      } else {
        threadId = conversationId || undefined;
      }
      const bound = await manager.bindTarget({
        agentId,
        boundBy,
        channelId,
        createThread,
        introText,
        label,
        metadata,
        targetKind: toThreadBindingTargetKind(input.targetKind),
        targetSessionKey,
        threadId,
        threadName,
      });
      return bound
        ? toSessionBindingRecord(bound, {
            idleTimeoutMs,
            maxAgeMs,
          })
        : null;
    },
    capabilities: {
      placements: ["current", "child"],
    },
    channel: "discord",
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs })),
    resolveByConversation: (ref) => {
      if (ref.channel !== "discord") {
        return null;
      }
      const binding = manager.getByThreadId(ref.conversationId);
      return binding ? toSessionBindingRecord(binding, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const threadId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (!threadId) {
        return;
      }
      manager.touchThread({ at, persist: true, threadId });
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = manager.unbindBySessionKey({
          reason: input.reason,
          targetSessionKey: input.targetSessionKey,
        });
        return removed.map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
      }
      const threadId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!threadId) {
        return [];
      }
      const removed = manager.unbindThread({
        reason: input.reason,
        threadId,
      });
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  registerManager(manager);
  return manager;
}

export function createNoopThreadBindingManager(accountId?: string): ThreadBindingManager {
  return createNoopManager(accountId);
}

export function getThreadBindingManager(accountId?: string): ThreadBindingManager | null {
  const normalized = normalizeAccountId(accountId);
  return MANAGERS_BY_ACCOUNT_ID.get(normalized) ?? null;
}

export const __testing = {
  resetThreadBindingsForTests,
  resolveThreadBindingThreadName,
  resolveThreadBindingsPath,
  runThreadBindingSweepForAccount: async (accountId?: string) => {
    const sweep = SWEEPERS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId));
    if (sweep) {
      await sweep();
    }
  },
};
