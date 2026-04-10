import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../agents/identity.js";
import {
  chunkByNewline,
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import {
  hasControlCommand,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "../../auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../auto-reply/commands-registry.js";
import { withReplyDispatcher } from "../../auto-reply/dispatch.js";
import {
  formatAgentEnvelope,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
} from "../../auto-reply/reply/mentions.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { removeAckReactionAfterReply, shouldAckReaction } from "../../channels/ack-reactions.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "../../channels/mention-gating.js";
import {
  setChannelConversationBindingIdleTimeoutBySessionKey,
  setChannelConversationBindingMaxAgeBySessionKey,
} from "../../channels/plugins/conversation-bindings.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import { recordInboundSession } from "../../channels/session.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../../config/sessions.js";
import { getChannelActivity, recordChannelActivity } from "../../infra/channel-activity.js";
import { createSubsystemLogger } from "../../logging.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { buildAgentSessionKey, resolveAgentRoute } from "../../routing/resolve-route.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type {
  PluginRuntimeChannelContextEvent,
  PluginRuntimeChannelContextKey,
} from "./types-channel.js";
import type { PluginRuntime } from "./types.js";

interface StoredRuntimeContext {
  token: symbol;
  context: unknown;
  normalizedKey: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
}

const log = createSubsystemLogger("plugins/runtime-channel");

function normalizeRuntimeContextString(value: string | null | undefined): string {
  return normalizeOptionalString(value) ?? "";
}

function normalizeRuntimeContextKey(params: PluginRuntimeChannelContextKey): {
  mapKey: string;
  normalizedKey: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
} | null {
  const channelId = normalizeRuntimeContextString(params.channelId);
  const capability = normalizeRuntimeContextString(params.capability);
  const accountId = normalizeRuntimeContextString(params.accountId);
  if (!channelId || !capability) {
    return null;
  }
  return {
    mapKey: `${channelId}\u0000${accountId}\u0000${capability}`,
    normalizedKey: {
      capability,
      channelId,
      ...(accountId ? { accountId } : {}),
    },
  };
}

function doesRuntimeContextWatcherMatch(params: {
  watcher: {
    channelId?: string;
    accountId?: string;
    capability?: string;
  };
  event: PluginRuntimeChannelContextEvent;
}): boolean {
  if (params.watcher.channelId && params.watcher.channelId !== params.event.key.channelId) {
    return false;
  }
  if (
    params.watcher.accountId !== undefined &&
    params.watcher.accountId !== (params.event.key.accountId ?? "")
  ) {
    return false;
  }
  if (params.watcher.capability && params.watcher.capability !== params.event.key.capability) {
    return false;
  }
  return true;
}

export function createRuntimeChannel(): PluginRuntime["channel"] {
  const runtimeContexts = new Map<string, StoredRuntimeContext>();
  const runtimeContextWatchers = new Set<{
    filter: {
      channelId?: string;
      accountId?: string;
      capability?: string;
    };
    onEvent: (event: PluginRuntimeChannelContextEvent) => void;
  }>();
  const emitRuntimeContextEvent = (event: PluginRuntimeChannelContextEvent) => {
    for (const watcher of runtimeContextWatchers) {
      if (!doesRuntimeContextWatcherMatch({ event, watcher: watcher.filter })) {
        continue;
      }
      try {
        watcher.onEvent(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          `runtime context watcher failed during ${event.type} ` +
            `channel=${event.key.channelId} capability=${event.key.capability}` +
            (event.key.accountId ? ` account=${event.key.accountId}` : "") +
            `: ${message}`,
        );
      }
    }
  };
  const channelRuntime = {
    activity: {
      get: getChannelActivity,
      record: recordChannelActivity,
    },
    commands: {
      isControlCommandMessage,
      resolveCommandAuthorizedFromAuthorizers,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands,
    },
    debounce: {
      createInboundDebouncer,
      resolveInboundDebounceMs,
    },
    groups: {
      resolveGroupPolicy: resolveChannelGroupPolicy,
      resolveRequireMention: resolveChannelGroupRequireMention,
    },
    media: {
      fetchRemoteMedia,
      saveMediaBuffer,
    },
    mentions: {
      buildMentionRegexes,
      implicitMentionKindWhen,
      matchesMentionPatterns,
      matchesMentionWithExplicit,
      resolveInboundMentionDecision,
    },
    outbound: {
      loadAdapter: loadChannelOutboundAdapter,
    },
    pairing: {
      buildPairingReply,
      readAllowFromStore: ({ channel, accountId, env }) =>
        readChannelAllowFromStore(channel, env, accountId),
      upsertPairingRequest: ({ channel, id, accountId, meta, env, pairingAdapter }) =>
        upsertChannelPairingRequest({
          accountId,
          channel,
          env,
          id,
          meta,
          pairingAdapter,
        }),
    },
    reactions: {
      removeAckReactionAfterReply,
      shouldAckReaction,
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher,
      createReplyDispatcherWithTyping,
      resolveEffectiveMessagesConfig,
      resolveHumanDelayConfig,
      dispatchReplyFromConfig,
      withReplyDispatcher,
      finalizeInboundContext,
      formatAgentEnvelope,
      /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
      formatInboundEnvelope,
      resolveEnvelopeFormatOptions,
    },
    routing: {
      buildAgentSessionKey,
      resolveAgentRoute,
    },
    runtimeContexts: {
      get: <T = unknown>(params: PluginRuntimeChannelContextKey) => {
        const normalized = normalizeRuntimeContextKey(params);
        if (!normalized) {
          return undefined;
        }
        return runtimeContexts.get(normalized.mapKey)?.context as T | undefined;
      },
      register: (params) => {
        const normalized = normalizeRuntimeContextKey(params);
        if (!normalized) {
          return { dispose: () => {} };
        }
        if (params.abortSignal?.aborted) {
          return { dispose: () => {} };
        }
        const token = Symbol(normalized.mapKey);
        let disposed = false;
        const dispose = () => {
          if (disposed) {
            return;
          }
          disposed = true;
          const current = runtimeContexts.get(normalized.mapKey);
          if (!current || current.token !== token) {
            return;
          }
          runtimeContexts.delete(normalized.mapKey);
          emitRuntimeContextEvent({
            key: normalized.normalizedKey,
            type: "unregistered",
          });
        };
        params.abortSignal?.addEventListener("abort", dispose, { once: true });
        if (params.abortSignal?.aborted) {
          dispose();
          return { dispose };
        }
        runtimeContexts.set(normalized.mapKey, {
          context: params.context,
          normalizedKey: normalized.normalizedKey,
          token,
        });
        if (disposed) {
          return { dispose };
        }
        emitRuntimeContextEvent({
          context: params.context,
          key: normalized.normalizedKey,
          type: "registered",
        });
        return { dispose };
      },
      watch: (params) => {
        const watcher = {
          filter: {
            ...(params.channelId?.trim() ? { channelId: params.channelId.trim() } : {}),
            ...(params.accountId != null ? { accountId: params.accountId.trim() } : {}),
            ...(params.capability?.trim() ? { capability: params.capability.trim() } : {}),
          },
          onEvent: params.onEvent,
        };
        runtimeContextWatchers.add(watcher);
        return () => {
          runtimeContextWatchers.delete(watcher);
        };
      },
    },
    session: {
      readSessionUpdatedAt,
      recordInboundSession,
      recordSessionMetaFromInbound,
      resolveStorePath,
      updateLastRoute,
    },
    text: {
      chunkByNewline,
      chunkMarkdownText,
      chunkMarkdownTextWithMode,
      chunkText,
      chunkTextWithMode,
      convertMarkdownTables,
      hasControlCommand,
      resolveChunkMode,
      resolveMarkdownTableMode,
      resolveTextChunkLimit,
    },
    threadBindings: {
      setIdleTimeoutBySessionKey: ({ channelId, targetSessionKey, accountId, idleTimeoutMs }) =>
        setChannelConversationBindingIdleTimeoutBySessionKey({
          accountId,
          channelId,
          idleTimeoutMs,
          targetSessionKey,
        }),
      setMaxAgeBySessionKey: ({ channelId, targetSessionKey, accountId, maxAgeMs }) =>
        setChannelConversationBindingMaxAgeBySessionKey({
          accountId,
          channelId,
          maxAgeMs,
          targetSessionKey,
        }),
    },
  } satisfies PluginRuntime["channel"];

  return channelRuntime as PluginRuntime["channel"];
}
