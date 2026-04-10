import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import {
  agentCommandFromIngress,
  buildOutboundSessionContext,
  createOutboundSendDeps,
  defaultRuntime,
  deleteMediaBuffer,
  deliverOutboundPayloads,
  enqueueSystemEvent,
  formatForLog,
  loadConfig,
  loadOrCreateDeviceIdentity,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  normalizeChannelId,
  normalizeMainKey,
  normalizeRpcAttachmentsToChatAttachments,
  parseMessageWithAttachments,
  registerApnsRegistration,
  requestHeartbeatNow,
  resolveGatewayModelSupportsImages,
  resolveOutboundTarget,
  resolveSessionAgentId,
  resolveSessionModelRef,
  sanitizeInboundSystemTags,
  scopedHeartbeatWakeOptions,
  updateSessionStore,
} from "./server-node-events.runtime.js";

const MAX_EXEC_EVENT_OUTPUT_CHARS = 180;
const MAX_NOTIFICATION_EVENT_TEXT_CHARS = 120;
const VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS = 1500;
const MAX_RECENT_VOICE_TRANSCRIPTS = 200;

const recentVoiceTranscripts = new Map<string, { fingerprint: string; ts: number }>();

function normalizeFiniteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function resolveVoiceTranscriptFingerprint(obj: Record<string, unknown>, text: string): string {
  const eventId =
    normalizeOptionalString(obj.eventId) ??
    normalizeOptionalString(obj.providerEventId) ??
    normalizeOptionalString(obj.transcriptId);
  if (eventId) {
    return `event:${eventId}`;
  }

  const callId = normalizeOptionalString(obj.providerCallId) ?? normalizeOptionalString(obj.callId);
  const sequence = normalizeFiniteInteger(obj.sequence) ?? normalizeFiniteInteger(obj.seq);
  if (callId && sequence !== null) {
    return `call-seq:${callId}:${sequence}`;
  }

  const eventTimestamp =
    normalizeFiniteInteger(obj.timestamp) ??
    normalizeFiniteInteger(obj.ts) ??
    normalizeFiniteInteger(obj.eventTimestamp);
  if (callId && eventTimestamp !== null) {
    return `call-ts:${callId}:${eventTimestamp}`;
  }

  if (eventTimestamp !== null) {
    return `timestamp:${eventTimestamp}|text:${text}`;
  }

  return `text:${text}`;
}

function shouldDropDuplicateVoiceTranscript(params: {
  sessionKey: string;
  fingerprint: string;
  now: number;
}): boolean {
  const previous = recentVoiceTranscripts.get(params.sessionKey);
  if (
    previous &&
    previous.fingerprint === params.fingerprint &&
    params.now - previous.ts <= VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS
  ) {
    return true;
  }
  recentVoiceTranscripts.set(params.sessionKey, {
    fingerprint: params.fingerprint,
    ts: params.now,
  });

  if (recentVoiceTranscripts.size > MAX_RECENT_VOICE_TRANSCRIPTS) {
    const cutoff = params.now - VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS * 2;
    for (const [key, value] of recentVoiceTranscripts) {
      if (value.ts < cutoff) {
        recentVoiceTranscripts.delete(key);
      }
      if (recentVoiceTranscripts.size <= MAX_RECENT_VOICE_TRANSCRIPTS) {
        break;
      }
    }
    while (recentVoiceTranscripts.size > MAX_RECENT_VOICE_TRANSCRIPTS) {
      const oldestKey = recentVoiceTranscripts.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      recentVoiceTranscripts.delete(oldestKey);
    }
  }

  return false;
}

function compactExecEventOutput(raw: string) {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_EXEC_EVENT_OUTPUT_CHARS) {
    return normalized;
  }
  const safe = Math.max(1, MAX_EXEC_EVENT_OUTPUT_CHARS - 1);
  return `${normalized.slice(0, safe)}…`;
}

function compactNotificationEventText(raw: string) {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_NOTIFICATION_EVENT_TEXT_CHARS) {
    return normalized;
  }
  const safe = Math.max(1, MAX_NOTIFICATION_EVENT_TEXT_CHARS - 1);
  return `${normalized.slice(0, safe)}…`;
}

type LoadedSessionEntry = ReturnType<typeof loadSessionEntry>;

async function touchSessionStore(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  storePath: LoadedSessionEntry["storePath"];
  canonicalKey: LoadedSessionEntry["canonicalKey"];
  entry: LoadedSessionEntry["entry"];
  sessionId: string;
  now: number;
}) {
  const { storePath } = params;
  if (!storePath) {
    return;
  }
  await updateSessionStore(storePath, (store) => {
    const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
      cfg: params.cfg,
      key: params.sessionKey,
      store,
    });
    store[primaryKey] = {
      ...store[primaryKey],
      fastMode: params.entry?.fastMode,
      lastAccountId: params.entry?.lastAccountId,
      lastChannel: params.entry?.lastChannel,
      lastThreadId: params.entry?.lastThreadId,
      lastTo: params.entry?.lastTo,
      reasoningLevel: params.entry?.reasoningLevel,
      sendPolicy: params.entry?.sendPolicy,
      sessionId: params.sessionId,
      systemSent: params.entry?.systemSent,
      thinkingLevel: params.entry?.thinkingLevel,
      updatedAt: params.now,
      verboseLevel: params.entry?.verboseLevel,
    };
  });
}

function queueSessionStoreTouch(params: {
  ctx: NodeEventContext;
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  storePath: LoadedSessionEntry["storePath"];
  canonicalKey: LoadedSessionEntry["canonicalKey"];
  entry: LoadedSessionEntry["entry"];
  sessionId: string;
  now: number;
}) {
  void touchSessionStore({
    canonicalKey: params.canonicalKey,
    cfg: params.cfg,
    entry: params.entry,
    now: params.now,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  }).catch((error) => {
    params.ctx.logGateway.warn("voice session-store update failed: " + formatForLog(error));
  });
}

function parseSessionKeyFromPayloadJSON(payloadJSON: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJSON) as unknown;
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const sessionKey = normalizeOptionalString(obj.sessionKey) ?? "";
  return sessionKey.length > 0 ? sessionKey : null;
}

function parsePayloadObject(payloadJSON?: string | null): Record<string, unknown> | null {
  if (!payloadJSON) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJSON) as unknown;
  } catch {
    return null;
  }
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

async function sendReceiptAck(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: NodeEventContext["deps"];
  sessionKey: string;
  channel: string;
  to: string;
  text: string;
}) {
  const resolved = resolveOutboundTarget({
    cfg: params.cfg,
    channel: params.channel,
    mode: "explicit",
    to: params.to,
  });
  if (!resolved.ok) {
    throw new Error(String(resolved.error));
  }
  const session = buildOutboundSessionContext({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  await deliverOutboundPayloads({
    bestEffort: true,
    cfg: params.cfg,
    channel: params.channel,
    deps: createOutboundSendDeps(params.deps),
    payloads: [{ text: params.text }],
    session,
    to: resolved.to,
  });
}

export const handleNodeEvent = async (ctx: NodeEventContext, nodeId: string, evt: NodeEvent) => {
  switch (evt.event) {
    case "voice.transcript": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return;
      }
      const text = normalizeOptionalString(obj.text) ?? "";
      if (!text) {
        return;
      }
      if (text.length > 20_000) {
        return;
      }
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? "";
      const cfg = loadConfig();
      const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : rawMainKey;
      const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
      const now = Date.now();
      const fingerprint = resolveVoiceTranscriptFingerprint(obj, text);
      if (shouldDropDuplicateVoiceTranscript({ fingerprint, now, sessionKey: canonicalKey })) {
        return;
      }
      const sessionId = entry?.sessionId ?? randomUUID();
      queueSessionStoreTouch({
        canonicalKey,
        cfg,
        ctx,
        entry,
        now,
        sessionId,
        sessionKey,
        storePath,
      });
      const runId = randomUUID();

      // Ensure chat UI clients refresh when this run completes (even though it wasn't started via chat.send).
      // This maps agent bus events (keyed by per-turn runId) to chat events (keyed by clientRunId).
      ctx.addChatRun(runId, {
        clientRunId: `voice-${randomUUID()}`,
        sessionKey: canonicalKey,
      });

      void agentCommandFromIngress(
        {
          allowModelOverride: false,
          deliver: false,
          inputProvenance: {
            kind: "external_user",
            sourceChannel: "voice",
            sourceTool: "gateway.voice.transcript",
          },
          message: text,
          messageChannel: "node",
          runId,
          senderIsOwner: false,
          sessionId,
          sessionKey: canonicalKey,
          thinking: "low",
        },
        defaultRuntime,
        ctx.deps,
      ).catch((error) => {
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(error)}`);
      });
      return;
    }
    case "agent.request": {
      if (!evt.payloadJSON) {
        return;
      }
      interface AgentDeepLink {
        message?: string;
        sessionKey?: string | null;
        thinking?: string | null;
        deliver?: boolean;
        attachments?: {
          type?: string;
          mimeType?: string;
          fileName?: string;
          content?: unknown;
        }[] | null;
        receipt?: boolean;
        receiptText?: string | null;
        to?: string | null;
        channel?: string | null;
        timeoutSeconds?: number | null;
        key?: string | null;
      }

      let link: AgentDeepLink | null = null;
      try {
        link = JSON.parse(evt.payloadJSON) as AgentDeepLink;
      } catch {
        return;
      }

      const sessionKeyRaw = (link?.sessionKey ?? "").trim();
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
      const cfg = loadConfig();
      const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);

      let message = (link?.message ?? "").trim();
      const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
        link?.attachments ?? undefined,
      );
      let images: { type: "image"; data: string; mimeType: string }[] = [];
      let imageOrder: PromptImageOrderEntry[] = [];
      if (!message && normalizedAttachments.length === 0) {
        return;
      }
      if (message.length > 20_000) {
        return;
      }
      if (normalizedAttachments.length > 0) {
        const sessionAgentId = resolveSessionAgentId({ config: cfg, sessionKey });
        const modelRef = resolveSessionModelRef(cfg, entry, sessionAgentId);
        const supportsImages = await resolveGatewayModelSupportsImages({
          loadGatewayModelCatalog: ctx.loadGatewayModelCatalog,
          model: modelRef.model,
          provider: modelRef.provider,
        });
        try {
          const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
            log: ctx.logGateway,
            maxBytes: 5_000_000,
            supportsImages,
          });
          message = parsed.message.trim();
          ({ images } = parsed);
          ({ imageOrder } = parsed);
          if (message.length > 20_000) {
            ctx.logGateway.warn(
              `agent.request message exceeds limit after attachment parsing (length=${message.length})`,
            );
            if (parsed.offloadedRefs && parsed.offloadedRefs.length > 0) {
              for (const ref of parsed.offloadedRefs) {
                try {
                  await deleteMediaBuffer(ref.id);
                } catch (error) {
                  ctx.logGateway.warn(
                    `Failed to cleanup orphaned media ${ref.id}: ${formatErrorMessage(error)}`,
                  );
                }
              }
            }
            return;
          }
        } catch (error) {
          ctx.logGateway.warn(`agent.request attachment parse failed: ${formatErrorMessage(error)}`);
          return;
        }
      }

      if (!message && images.length === 0) {
        return;
      }

      const channelRaw = normalizeOptionalString(link?.channel) ?? "";
      let channel = normalizeChannelId(channelRaw) ?? undefined;
      let to = normalizeOptionalString(link?.to);
      const deliverRequested = Boolean(link?.deliver);
      const wantsReceipt = Boolean(link?.receipt);
      const receiptText =
        normalizeOptionalString(link?.receiptText) ||
        "Just received your iOS share + request, working on it.";

      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      await touchSessionStore({ canonicalKey, cfg, entry, now, sessionId, sessionKey, storePath });

      if (deliverRequested && (!channel || !to)) {
        const entryChannel =
          typeof entry?.lastChannel === "string"
            ? normalizeChannelId(entry.lastChannel)
            : undefined;
        const entryTo = normalizeOptionalString(entry?.lastTo) ?? "";
        if (!channel && entryChannel) {
          channel = entryChannel;
        }
        if (!to && entryTo) {
          to = entryTo;
        }
      }
      const deliver = deliverRequested && Boolean(channel && to);
      const deliveryChannel = deliver ? channel : undefined;
      const deliveryTo = deliver ? to : undefined;
      if (deliverRequested && !deliver) {
        ctx.logGateway.warn(
          `agent delivery disabled node=${nodeId}: missing session delivery route (channel=${channel ?? "-"} to=${to ?? "-"})`,
        );
      }

      if (wantsReceipt && deliveryChannel && deliveryTo) {
        void sendReceiptAck({
          cfg,
          channel: deliveryChannel,
          deps: ctx.deps,
          sessionKey: canonicalKey,
          text: receiptText,
          to: deliveryTo,
        }).catch((error) => {
          ctx.logGateway.warn(`agent receipt failed node=${nodeId}: ${formatForLog(error)}`);
        });
      } else if (wantsReceipt) {
        ctx.logGateway.warn(
          `agent receipt skipped node=${nodeId}: missing delivery route (channel=${deliveryChannel ?? "-"} to=${deliveryTo ?? "-"})`,
        );
      }

      void agentCommandFromIngress(
        {
          allowModelOverride: false,
          channel: deliveryChannel,
          deliver,
          imageOrder,
          images,
          message,
          messageChannel: "node",
          runId: sessionId,
          senderIsOwner: false,
          sessionId,
          sessionKey: canonicalKey,
          thinking: link?.thinking ?? undefined,
          timeout:
            typeof link?.timeoutSeconds === "number" ? link.timeoutSeconds.toString() : undefined,
          to: deliveryTo,
        },
        defaultRuntime,
        ctx.deps,
      ).catch((error) => {
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(error)}`);
      });
      return;
    }
    case "notifications.changed": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return;
      }
      const change = normalizeOptionalString(obj.change)
        ? normalizeLowercaseStringOrEmpty(obj.change)
        : undefined;
      if (change !== "posted" && change !== "removed") {
        return;
      }
      const keyRaw = normalizeOptionalString(obj.key);
      if (!keyRaw) {
        return;
      }
      const key = sanitizeInboundSystemTags(keyRaw);
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
      const { canonicalKey: sessionKey } = loadSessionEntry(sessionKeyRaw);
      const packageNameRaw = normalizeOptionalString(obj.packageName);
      const packageName = packageNameRaw ? sanitizeInboundSystemTags(packageNameRaw) : null;
      const title = compactNotificationEventText(
        sanitizeInboundSystemTags(normalizeOptionalString(obj.title) ?? ""),
      );
      const text = compactNotificationEventText(
        sanitizeInboundSystemTags(normalizeOptionalString(obj.text) ?? ""),
      );

      let summary = `Notification ${change} (node=${nodeId} key=${key}`;
      if (packageName) {
        summary += ` package=${packageName}`;
      }
      summary += ")";
      if (change === "posted") {
        const messageParts = [title, text].filter(Boolean);
        if (messageParts.length > 0) {
          summary += `: ${messageParts.join(" - ")}`;
        }
      }

      const queued = enqueueSystemEvent(summary, {
        contextKey: `notification:${keyRaw}`,
        sessionKey,
        trusted: false,
      });
      if (queued) {
        requestHeartbeatNow({ reason: "notifications-event", sessionKey });
      }
      return;
    }
    case "chat.subscribe": {
      if (!evt.payloadJSON) {
        return;
      }
      const sessionKey = parseSessionKeyFromPayloadJSON(evt.payloadJSON);
      if (!sessionKey) {
        return;
      }
      ctx.nodeSubscribe(nodeId, sessionKey);
      return;
    }
    case "chat.unsubscribe": {
      if (!evt.payloadJSON) {
        return;
      }
      const sessionKey = parseSessionKeyFromPayloadJSON(evt.payloadJSON);
      if (!sessionKey) {
        return;
      }
      ctx.nodeUnsubscribe(nodeId, sessionKey);
      return;
    }
    case "exec.started":
    case "exec.finished":
    case "exec.denied": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return;
      }
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
      if (!sessionKeyRaw) {
        return;
      }
      const { canonicalKey: sessionKey } = loadSessionEntry(sessionKeyRaw);

      // Respect tools.exec.notifyOnExit setting (default: true)
      // When false, skip system event notifications for node exec events.
      const cfg = loadConfig();
      const notifyOnExit = cfg.tools?.exec?.notifyOnExit !== false;
      if (!notifyOnExit) {
        return;
      }
      if (obj.suppressNotifyOnExit === true) {
        return;
      }

      const runId = normalizeOptionalString(obj.runId) ?? "";
      const command = sanitizeInboundSystemTags(normalizeOptionalString(obj.command) ?? "");
      const exitCode =
        typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode)
          ? obj.exitCode
          : undefined;
      const timedOut = obj.timedOut === true;
      const output = sanitizeInboundSystemTags(normalizeOptionalString(obj.output) ?? "");
      const reason = sanitizeInboundSystemTags(normalizeOptionalString(obj.reason) ?? "");

      let text = "";
      if (evt.event === "exec.started") {
        text = `Exec started (node=${nodeId}${runId ? ` id=${runId}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      } else if (evt.event === "exec.finished") {
        const exitLabel = timedOut ? "timeout" : `code ${exitCode ?? "?"}`;
        const compactOutput = compactExecEventOutput(output);
        const shouldNotify = timedOut || exitCode !== 0 || compactOutput.length > 0;
        if (!shouldNotify) {
          return;
        }
        text = `Exec finished (node=${nodeId}${runId ? ` id=${runId}` : ""}, ${exitLabel})`;
        if (compactOutput) {
          text += `\n${compactOutput}`;
        }
      } else {
        text = `Exec denied (node=${nodeId}${runId ? ` id=${runId}` : ""}${reason ? `, ${reason}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      }

      enqueueSystemEvent(text, {
        contextKey: runId ? `exec:${runId}` : "exec",
        sessionKey,
        trusted: false,
      });
      // Scope wakes only for canonical agent sessions. Synthetic node-* fallback
      // Keys should keep legacy unscoped behavior so enabled non-main heartbeat
      // Agents still run when no explicit agent session is provided.
      requestHeartbeatNow(scopedHeartbeatWakeOptions(sessionKey, { reason: "exec-event" }));
      return;
    }
    case "push.apns.register": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return;
      }
      const transport = normalizeLowercaseStringOrEmpty(obj.transport) || "direct";
      const topic = typeof obj.topic === "string" ? obj.topic : "";
      const {environment} = obj;
      try {
        if (transport === "relay") {
          const gatewayDeviceId = normalizeOptionalString(obj.gatewayDeviceId) ?? "";
          const currentGatewayDeviceId = loadOrCreateDeviceIdentity().deviceId;
          if (!gatewayDeviceId || gatewayDeviceId !== currentGatewayDeviceId) {
            ctx.logGateway.warn(
              `push relay register rejected node=${nodeId}: gateway identity mismatch`,
            );
            return;
          }
          await registerApnsRegistration({
            distribution: obj.distribution,
            environment,
            installationId: typeof obj.installationId === "string" ? obj.installationId : "",
            nodeId,
            relayHandle: typeof obj.relayHandle === "string" ? obj.relayHandle : "",
            sendGrant: typeof obj.sendGrant === "string" ? obj.sendGrant : "",
            tokenDebugSuffix: obj.tokenDebugSuffix,
            topic,
            transport: "relay",
          });
        } else {
          await registerApnsRegistration({
            environment,
            nodeId,
            token: typeof obj.token === "string" ? obj.token : "",
            topic,
            transport: "direct",
          });
        }
      } catch (error) {
        ctx.logGateway.warn(`push apns register failed node=${nodeId}: ${formatForLog(error)}`);
      }
      return;
    }
    default: {
      return;
    }
  }
};
