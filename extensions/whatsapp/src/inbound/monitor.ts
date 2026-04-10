import type { AnyMessageContent, WAMessage, WASocket, proto } from "@whiskeysockets/baileys";
import { createInboundDebouncer, formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/text-runtime";
import { readWebSelfIdentity } from "../auth-store.js";
import { getPrimaryIdentityId, resolveComparableIdentity } from "../identity.js";
import { DEFAULT_RECONNECT_POLICY, computeBackoff, sleepWithAbort } from "../reconnect.js";
import { createWaSocket, formatError, getStatusCode, waitForWaConnection } from "../session.js";
import { resolveJidToE164 } from "../text-runtime.js";
import { checkInboundAccessControl } from "./access-control.js";
import {
  isRecentInboundMessage,
  isRecentOutboundMessage,
  rememberRecentOutboundMessage,
} from "./dedupe.js";
import {
  describeReplyContext,
  extractLocationData,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "./extract.js";
import { attachEmitterListener, closeInboundMonitorSocket } from "./lifecycle.js";
import { downloadInboundMedia } from "./media.js";
import { DisconnectReason, isJidGroup, saveMediaBuffer } from "./runtime-api.js";
import { createWebSendApi } from "./send-api.js";
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const RECONNECT_IN_PROGRESS_ERROR = "no active socket - reconnection in progress";

function isGroupJid(jid: string): boolean {
  return (typeof isJidGroup === "function" ? isJidGroup(jid) : jid.endsWith("@g.us")) === true;
}

function isRetryableSendDisconnectError(err: unknown): boolean {
  return /closed|reset|timed\s*out|disconnect|no active socket/i.test(formatError(err));
}

function shouldClearSocketRefAfterSendFailure(err: unknown): boolean {
  return /closed|reset|disconnect|no active socket/i.test(formatError(err));
}

export async function monitorWebInbox(options: {
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Keep the global presence unavailable so self-chat sessions do not mute phone pushes. */
  selfChatMode?: boolean;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
  /** Optional shared socket reference so reply closures can follow reconnects. */
  socketRef?: { current: WASocket | null };
  /** Whether send retries should wait for a reconnect. */
  shouldRetryDisconnect?: () => boolean;
  /** Reconnect timing for waiting through transient socket replacement gaps. */
  disconnectRetryPolicy?: {
    initialMs: number;
    maxMs: number;
    factor: number;
    jitter: number;
    maxAttempts: number;
  };
  /** Abort in-flight reconnect waits when shutdown becomes terminal. */
  disconnectRetryAbortSignal?: AbortSignal;
}) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
  });
  await waitForWaConnection(sock);
  const connectedAtMs = Date.now();
  if (options.socketRef) {
    options.socketRef.current = sock;
  }
  const getCurrentSock = () => (options.socketRef ? options.socketRef.current : sock);
  const shouldRetryDisconnect = () => options.shouldRetryDisconnect?.() === true;
  const disconnectRetryPolicy = options.disconnectRetryPolicy ?? DEFAULT_RECONNECT_POLICY;
  const sendRetryMaxAttempts =
    disconnectRetryPolicy.maxAttempts > 0
      ? disconnectRetryPolicy.maxAttempts
      : DEFAULT_RECONNECT_POLICY.maxAttempts;

  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };
  const presence = options.selfChatMode ? "unavailable" : "available";

  try {
    await sock.sendPresenceUpdate(presence);
    if (shouldLogVerbose()) {
      logVerbose(`Sent global '${presence}' presence on connect`);
    }
  } catch (error) {
    logVerbose(`Failed to send '${presence}' presence on connect: ${String(error)}`);
  }

  const self = await readWebSelfIdentity(
    options.authDir,
    sock.user as { id?: string | null; lid?: string | null } | undefined,
  );
  const debouncer = createInboundDebouncer<WebInboundMessage>({
    buildKey: (msg) => {
      const sender = msg.sender;
      const senderKey =
        msg.chatType === "group"
          ? (getPrimaryIdentityId(sender ?? null) ??
            msg.senderJid ??
            msg.senderE164 ??
            msg.senderName ??
            msg.from)
          : msg.from;
      if (!senderKey) {
        return null;
      }
      const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
      return `${msg.accountId}:${conversationKey}:${senderKey}`;
    },
    debounceMs: options.debounceMs ?? 0,
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await options.onMessage(last);
        return;
      }
      const mentioned = new Set<string>();
      for (const entry of entries) {
        for (const jid of entry.mentions ?? entry.mentionedJids ?? []) {
          mentioned.add(jid);
        }
      }
      const combinedBody = entries
        .map((entry) => entry.body)
        .filter(Boolean)
        .join("\n");
      const combinedMessage: WebInboundMessage = {
        ...last,
        body: combinedBody,
        mentions: mentioned.size > 0 ? Array.from(mentioned) : undefined,
        mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
      };
      await options.onMessage(combinedMessage);
    },
    shouldDebounce: options.shouldDebounce,
  });
  const groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lidLookup = sock.signalRepository?.lidMapping;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

  const rememberOutboundMessage = (remoteJid: string, result: unknown) => {
    const messageId =
      typeof result === "object" && result && "key" in result
        ? String((result as { key?: { id?: string } }).key?.id ?? "")
        : "";
    if (!messageId) {
      return;
    }
    rememberRecentOutboundMessage({
      accountId: options.accountId,
      messageId,
      remoteJid,
    });
  };

  const sendTrackedMessage = async (jid: string, content: AnyMessageContent) => {
    let lastErr: unknown = new Error(RECONNECT_IN_PROGRESS_ERROR);
    for (let attempt = 1; ; attempt++) {
      const currentSock = getCurrentSock();
      if (currentSock) {
        try {
          const result = await currentSock.sendMessage(jid, content);
          rememberOutboundMessage(jid, result);
          return result;
        } catch (error) {
          if (!shouldRetryDisconnect() || !isRetryableSendDisconnectError(error)) {
            throw error;
          }
          lastErr = error;
          if (
            shouldClearSocketRefAfterSendFailure(error) &&
            options.socketRef?.current === currentSock
          ) {
            options.socketRef.current = null;
          }
        }
      } else if (!shouldRetryDisconnect()) {
        throw lastErr;
      }

      if (attempt >= sendRetryMaxAttempts) {
        throw lastErr;
      }
      const delayMs = computeBackoff(disconnectRetryPolicy, attempt);
      logVerbose(
        `Waiting ${delayMs}ms for WhatsApp reconnect before retrying send to ${jid}: ${formatError(lastErr)}`,
      );
      try {
        await sleepWithAbort(delayMs, options.disconnectRetryAbortSignal);
      } catch {
        throw lastErr;
      }
    }
  };

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);
      const participants =
        (
          await Promise.all(
            meta.participants?.map(async (p) => {
              const mapped = await resolveInboundJid(p.id);
              return mapped ?? p.id;
            }) ?? [],
          )
        ).filter(Boolean) ?? [];
      const entry = {
        expires: Date.now() + GROUP_META_TTL_MS,
        participants,
        subject: meta.subject,
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (error) {
      logVerbose(`Failed to fetch group metadata for ${jid}: ${String(error)}`);
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  interface NormalizedInboundMessage {
    id?: string;
    remoteJid: string;
    group: boolean;
    participantJid?: string;
    from: string;
    senderE164: string | null;
    groupSubject?: string;
    groupParticipants?: string[];
    messageTimestampMs?: number;
    access: Awaited<ReturnType<typeof checkInboundAccessControl>>;
  }

  const normalizeInboundMessage = async (
    msg: WAMessage,
  ): Promise<NormalizedInboundMessage | null> => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) {
      return null;
    }
    if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      return null;
    }

    const group = isGroupJid(remoteJid);
    // Drop echoes of messages the gateway itself sent (tracked by sendTrackedMessage).
    // Applies to both groups and DMs/self-chat — without this, self-chat mode
    // Re-processes the bot's own replies as new inbound user messages.
    if (
      Boolean(msg.key?.fromMe) &&
      id &&
      isRecentOutboundMessage({
        accountId: options.accountId,
        messageId: id,
        remoteJid,
      })
    ) {
      logVerbose(`Skipping recent outbound WhatsApp echo ${id} for ${remoteJid}`);
      return null;
    }
    if (id) {
      const dedupeKey = `${options.accountId}:${remoteJid}:${id}`;
      if (isRecentInboundMessage(dedupeKey)) {
        return null;
      }
    }
    const participantJid = msg.key?.participant ?? undefined;
    const from = group ? remoteJid : await resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    const senderE164 = group
      ? (participantJid
        ? await resolveInboundJid(participantJid)
        : null)
      : from;

    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (group) {
      const meta = await getGroupMeta(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampMs = msg.messageTimestamp
      ? Number(msg.messageTimestamp) * 1000
      : undefined;

    const access = await checkInboundAccessControl({
      accountId: options.accountId,
      connectedAtMs,
      from,
      group,
      isFromMe: Boolean(msg.key?.fromMe),
      messageTimestampMs,
      pushName: msg.pushName ?? undefined,
      remoteJid,
      selfE164: self.e164 ?? null,
      senderE164,
      sock: { sendMessage: (jid, content) => sendTrackedMessage(jid, content) },
    });
    if (!access.allowed) {
      return null;
    }

    return {
      access,
      from,
      group,
      groupParticipants,
      groupSubject,
      id,
      messageTimestampMs,
      participantJid,
      remoteJid,
      senderE164,
    };
  };

  const maybeMarkInboundAsRead = async (inbound: NormalizedInboundMessage) => {
    const { id, remoteJid, participantJid, access } = inbound;
    if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
      try {
        await sock.readMessages([{ fromMe: false, id, participant: participantJid, remoteJid }]);
        if (shouldLogVerbose()) {
          const suffix = participantJid ? ` (participant ${participantJid})` : "";
          logVerbose(`Marked message ${id} as read for ${remoteJid}${suffix}`);
        }
      } catch (error) {
        logVerbose(`Failed to mark message ${id} read: ${String(error)}`);
      }
    } else if (id && access.isSelfChat && shouldLogVerbose()) {
      // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
      logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
    }
  };

  interface EnrichedInboundMessage {
    body: string;
    location?: ReturnType<typeof extractLocationData>;
    replyContext?: ReturnType<typeof describeReplyContext>;
    mediaPath?: string;
    mediaType?: string;
    mediaFileName?: string;
  }

  const enrichInboundMessage = async (msg: WAMessage): Promise<EnrichedInboundMessage | null> => {
    const location = extractLocationData(msg.message ?? undefined);
    const locationText = location ? formatLocationText(location) : undefined;
    let body = extractText(msg.message ?? undefined);
    if (locationText) {
      body = [body, locationText].filter(Boolean).join("\n").trim();
    }
    if (!body) {
      body = extractMediaPlaceholder(msg.message ?? undefined);
      if (!body) {
        return null;
      }
    }
    const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let mediaFileName: string | undefined;
    try {
      const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock);
      if (inboundMedia) {
        const maxMb =
          typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0
            ? options.mediaMaxMb
            : 50;
        const maxBytes = maxMb * 1024 * 1024;
        const saved = await saveMediaBuffer(
          inboundMedia.buffer,
          inboundMedia.mimetype,
          "inbound",
          maxBytes,
          inboundMedia.fileName,
        );
        mediaPath = saved.path;
        mediaType = inboundMedia.mimetype;
        mediaFileName = inboundMedia.fileName;
      }
    } catch (error) {
      logVerbose(`Inbound media download failed: ${String(error)}`);
    }

    return {
      body,
      location: location ?? undefined,
      mediaFileName,
      mediaPath,
      mediaType,
      replyContext,
    };
  };

  const enqueueInboundMessage = async (
    msg: WAMessage,
    inbound: NormalizedInboundMessage,
    enriched: EnrichedInboundMessage,
  ) => {
    const chatJid = inbound.remoteJid;
    const sendComposing = async () => {
      const currentSock = getCurrentSock();
      if (!currentSock) {
        return;
      }
      try {
        await currentSock.sendPresenceUpdate("composing", chatJid);
      } catch (error) {
        logVerbose(`Presence update failed: ${String(error)}`);
      }
    };
    const reply = async (text: string) => {
      await sendTrackedMessage(chatJid, { text });
    };
    const sendMedia = async (payload: AnyMessageContent) => {
      await sendTrackedMessage(chatJid, payload);
    };
    const timestamp = inbound.messageTimestampMs;
    const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
    const senderName = msg.pushName ?? undefined;

    inboundLogger.info(
      {
        body: enriched.body,
        from: inbound.from,
        mediaFileName: enriched.mediaFileName,
        mediaPath: enriched.mediaPath,
        mediaType: enriched.mediaType,
        timestamp,
        to: self.e164 ?? "me",
      },
      "inbound message",
    );
    const inboundMessage: WebInboundMessage = {
      accountId: inbound.access.resolvedAccountId,
      body: enriched.body,
      chatId: inbound.remoteJid,
      chatType: inbound.group ? "group" : "direct",
      conversationId: inbound.from,
      from: inbound.from,
      fromMe: Boolean(msg.key?.fromMe),
      groupParticipants: inbound.groupParticipants,
      groupSubject: inbound.groupSubject,
      id: inbound.id,
      location: enriched.location ?? undefined,
      mediaFileName: enriched.mediaFileName,
      mediaPath: enriched.mediaPath,
      mediaType: enriched.mediaType,
      mentionedJids: mentionedJids ?? undefined,
      mentions: mentionedJids ?? undefined,
      pushName: senderName,
      reply,
      replyTo: enriched.replyContext ?? undefined,
      replyToBody: enriched.replyContext?.body,
      replyToId: enriched.replyContext?.id,
      replyToSender: enriched.replyContext?.sender?.label ?? undefined,
      replyToSenderE164: enriched.replyContext?.sender?.e164 ?? undefined,
      replyToSenderJid: enriched.replyContext?.sender?.jid ?? undefined,
      self,
      selfE164: self.e164 ?? undefined,
      selfJid: self.jid ?? undefined,
      selfLid: self.lid ?? undefined,
      sendComposing,
      sendMedia,
      sender: resolveComparableIdentity({
        jid: inbound.participantJid,
        e164: inbound.senderE164 ?? undefined,
        name: senderName,
      }),
      senderE164: inbound.senderE164 ?? undefined,
      senderJid: inbound.participantJid,
      senderName,
      timestamp,
      to: self.e164 ?? "me",
    };
    try {
      const task = Promise.resolve(debouncer.enqueue(inboundMessage));
      void task.catch((error) => {
        inboundLogger.error({ error: String(error) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(error)}`);
      });
    } catch (error) {
      inboundLogger.error({ error: String(error) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(error)}`);
    }
  };

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: WAMessage[] }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      recordChannelActivity({
        accountId: options.accountId,
        channel: "whatsapp",
        direction: "inbound",
      });
      const inbound = await normalizeInboundMessage(msg);
      if (!inbound) {
        continue;
      }

      await maybeMarkInboundAsRead(inbound);

      // If this is history/offline catch-up, mark read above but skip auto-reply.
      if (upsert.type === "append") {
        const APPEND_RECENT_GRACE_MS = 60_000;
        const msgTsRaw = msg.messageTimestamp;
        const msgTsNum = msgTsRaw != null ? Number(msgTsRaw) : Number.NaN;
        const msgTsMs = Number.isFinite(msgTsNum) ? msgTsNum * 1000 : 0;
        if (msgTsMs < connectedAtMs - APPEND_RECENT_GRACE_MS) {
          continue;
        }
      }

      const enriched = await enrichInboundMessage(msg);
      if (!enriched) {
        continue;
      }

      await enqueueInboundMessage(msg, inbound, enriched);
    }
  };
  const handleConnectionUpdate = (
    update: Partial<import("@whiskeysockets/baileys").ConnectionState>,
  ) => {
    try {
      if (update.connection === "close") {
        if (options.socketRef?.current === sock) {
          options.socketRef.current = null;
        }
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          error: update.lastDisconnect?.error,
          isLoggedOut: status === LOGGED_OUT_STATUS,
          status,
        });
      }
    } catch (error) {
      inboundLogger.error({ error: String(error) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: error });
    }
  };
  const detachMessagesUpsert = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "messages.upsert",
    handleMessagesUpsert as unknown as (...args: unknown[]) => void,
  );
  const detachConnectionUpdate = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "connection.update",
    handleConnectionUpdate as unknown as (...args: unknown[]) => void,
  );

  void (async () => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      if (shouldLogVerbose()) {
        logVerbose(`Hydrated ${Object.keys(groups ?? {}).length} participating groups on connect`);
      }
    } catch (error) {
      const error = String(error);
      inboundLogger.warn({ error }, "failed hydrating participating groups on connect");
      inboundConsoleLog.warn(`Failed hydrating participating groups on connect: ${error}`);
      logVerbose(`Failed to hydrate participating groups on connect: ${error}`);
    }
  })();

  const sendApi = createWebSendApi({
    defaultAccountId: options.accountId,
    sock: {
      sendMessage: (jid: string, content: AnyMessageContent) => sendTrackedMessage(jid, content),
      sendPresenceUpdate: async (presence, jid?: string) => {
        const currentSock = getCurrentSock();
        if (!currentSock) {
          throw new Error(RECONNECT_IN_PROGRESS_ERROR);
        }
        return currentSock.sendPresenceUpdate(presence, jid);
      },
    },
  });

  return {
    close: async () => {
      try {
        detachMessagesUpsert();
        detachConnectionUpdate();
        closeInboundMonitorSocket(sock);
      } catch (error) {
        logVerbose(`Socket close failed: ${String(error)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { error: "closed", isLoggedOut: false, status: undefined });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
  } as const;
}
