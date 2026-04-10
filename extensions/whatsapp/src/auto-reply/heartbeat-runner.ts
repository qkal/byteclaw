import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { newConnectionId } from "../reconnect.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  HEARTBEAT_TOKEN,
  appendCronStyleCurrentTimeLine,
  canonicalizeMainSessionAlias,
  emitHeartbeatEvent,
  formatError,
  getChildLogger,
  getReplyFromConfig,
  hasOutboundReplyContent,
  loadConfig,
  loadSessionStore,
  normalizeMainKey,
  redactIdentifier,
  resolveHeartbeatPrompt,
  resolveHeartbeatReplyPayload,
  resolveHeartbeatVisibility,
  resolveIndicatorType,
  resolveSendableOutboundReplyParts,
  resolveSessionKey,
  resolveStorePath,
  resolveWhatsAppHeartbeatRecipients,
  sendMessageWhatsApp,
  stripHeartbeatToken,
  updateSessionStore,
  whatsappHeartbeatLog,
} from "./heartbeat-runner.runtime.js";
import { getSessionSnapshot } from "./session-snapshot.js";

function resolveDefaultAgentIdFromConfig(cfg: ReturnType<typeof loadConfig>): string {
  const agents = cfg.agents?.list ?? [];
  const chosen = agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? "main";
  return normalizeOptionalLowercaseString(chosen) ?? "main";
}

export async function runWebHeartbeatOnce(opts: {
  cfg?: ReturnType<typeof loadConfig>;
  to: string;
  verbose?: boolean;
  replyResolver?: typeof getReplyFromConfig;
  sender?: typeof sendMessageWhatsApp;
  sessionId?: string;
  overrideBody?: string;
  dryRun?: boolean;
}) {
  const { cfg: cfgOverride, to, verbose = false, sessionId, overrideBody, dryRun = false } = opts;
  const replyResolver = opts.replyResolver ?? getReplyFromConfig;
  const sender = opts.sender ?? sendMessageWhatsApp;
  const runId = newConnectionId();
  const redactedTo = redactIdentifier(to);
  const heartbeatLogger = getChildLogger({
    module: "web-heartbeat",
    runId,
    to: redactedTo,
  });

  const cfg = cfgOverride ?? loadConfig();

  // Resolve heartbeat visibility settings for WhatsApp
  const visibility = resolveHeartbeatVisibility({ cfg, channel: "whatsapp" });
  const heartbeatOkText = HEARTBEAT_TOKEN;

  const maybeSendHeartbeatOk = async (): Promise<boolean> => {
    if (!visibility.showOk) {
      return false;
    }
    if (dryRun) {
      whatsappHeartbeatLog.info(`[dry-run] heartbeat ok -> ${redactedTo}`);
      return false;
    }
    const sendResult = await sender(to, heartbeatOkText, { verbose });
    heartbeatLogger.info(
      {
        chars: heartbeatOkText.length,
        messageId: sendResult.messageId,
        reason: "heartbeat-ok",
        to: redactedTo,
      },
      "heartbeat ok sent",
    );
    whatsappHeartbeatLog.info(`heartbeat ok sent to ${redactedTo} (id ${sendResult.messageId})`);
    return true;
  };

  const sessionCfg = cfg.session;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  // Canonicalize so the written key matches what read paths produce (#29683).
  const rawSessionKey = resolveSessionKey(sessionScope, { From: to }, mainKey);
  const sessionKey = canonicalizeMainSessionAlias({
    agentId: resolveDefaultAgentIdFromConfig(cfg),
    cfg,
    sessionKey: rawSessionKey,
  });
  if (sessionId) {
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    const current = store[sessionKey] ?? {};
    store[sessionKey] = {
      ...current,
      sessionId,
      updatedAt: Date.now(),
    };
    await updateSessionStore(storePath, (nextStore) => {
      const nextCurrent = nextStore[sessionKey] ?? current;
      nextStore[sessionKey] = {
        ...nextCurrent,
        sessionId,
        updatedAt: Date.now(),
      };
    });
  }
  const sessionSnapshot = getSessionSnapshot(cfg, to, true, { sessionKey });
  if (verbose) {
    heartbeatLogger.info(
      {
        dailyResetAt: sessionSnapshot.dailyResetAt ?? null,
        idleExpiresAt: sessionSnapshot.idleExpiresAt ?? null,
        idleMinutes: sessionSnapshot.resetPolicy.idleMinutes ?? null,
        resetAtHour: sessionSnapshot.resetPolicy.atHour,
        resetMode: sessionSnapshot.resetPolicy.mode,
        sessionFresh: sessionSnapshot.fresh,
        sessionId: sessionId ?? sessionSnapshot.entry?.sessionId ?? null,
        sessionKey: sessionSnapshot.key,
        to: redactedTo,
      },
      "heartbeat session snapshot",
    );
  }

  if (overrideBody && overrideBody.trim().length === 0) {
    throw new Error("Override body must be non-empty when provided.");
  }

  try {
    if (overrideBody) {
      if (dryRun) {
        whatsappHeartbeatLog.info(
          `[dry-run] web send -> ${redactedTo} (${overrideBody.trim().length} chars, manual message)`,
        );
        return;
      }
      const sendResult = await sender(to, overrideBody, { verbose });
      emitHeartbeatEvent({
        channel: "whatsapp",
        hasMedia: false,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
        preview: overrideBody.slice(0, 160),
        status: "sent",
        to,
      });
      heartbeatLogger.info(
        {
          chars: overrideBody.length,
          messageId: sendResult.messageId,
          reason: "manual-message",
          to: redactedTo,
        },
        "manual heartbeat message sent",
      );
      whatsappHeartbeatLog.info(
        `manual heartbeat sent to ${redactedTo} (id ${sendResult.messageId})`,
      );
      return;
    }

    if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
      heartbeatLogger.info({ reason: "alerts-disabled", to: redactedTo }, "heartbeat skipped");
      emitHeartbeatEvent({
        channel: "whatsapp",
        reason: "alerts-disabled",
        status: "skipped",
        to,
      });
      return;
    }

    const replyResult = await replyResolver(
      {
        Body: appendCronStyleCurrentTimeLine(
          resolveHeartbeatPrompt(cfg.agents?.defaults?.heartbeat?.prompt),
          cfg,
          Date.now(),
        ),
        From: to,
        MessageSid: sessionId ?? sessionSnapshot.entry?.sessionId,
        To: to,
      },
      { isHeartbeat: true },
      cfg,
    );
    const replyPayload = resolveHeartbeatReplyPayload(replyResult);

    if (!replyPayload || !hasOutboundReplyContent(replyPayload)) {
      heartbeatLogger.info(
        {
          reason: "empty-reply",
          sessionId: sessionSnapshot.entry?.sessionId ?? null,
          to: redactedTo,
        },
        "heartbeat skipped",
      );
      const okSent = await maybeSendHeartbeatOk();
      emitHeartbeatEvent({
        channel: "whatsapp",
        indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-empty") : undefined,
        silent: !okSent,
        status: "ok-empty",
        to,
      });
      return;
    }

    const reply = resolveSendableOutboundReplyParts(replyPayload);
    const {hasMedia} = reply;
    const ackMaxChars = Math.max(
      0,
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    );
    const stripped = stripHeartbeatToken(replyPayload.text, {
      maxAckChars: ackMaxChars,
      mode: "heartbeat",
    });
    if (stripped.shouldSkip && !hasMedia) {
      // Don't let heartbeats keep sessions alive: restore previous updatedAt so idle expiry still works.
      const storePath = resolveStorePath(cfg.session?.store);
      const store = loadSessionStore(storePath);
      if (sessionSnapshot.entry && store[sessionSnapshot.key]) {
        store[sessionSnapshot.key].updatedAt = sessionSnapshot.entry.updatedAt;
        await updateSessionStore(storePath, (nextStore) => {
          const nextEntry = nextStore[sessionSnapshot.key];
          if (!nextEntry) {
            return;
          }
          nextStore[sessionSnapshot.key] = {
            ...nextEntry,
            updatedAt: sessionSnapshot.entry.updatedAt,
          };
        });
      }

      heartbeatLogger.info(
        { rawLength: replyPayload.text?.length, reason: "heartbeat-token", to: redactedTo },
        "heartbeat skipped",
      );
      const okSent = await maybeSendHeartbeatOk();
      emitHeartbeatEvent({
        channel: "whatsapp",
        indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-token") : undefined,
        silent: !okSent,
        status: "ok-token",
        to,
      });
      return;
    }

    if (hasMedia) {
      heartbeatLogger.warn(
        { to: redactedTo },
        "heartbeat reply contained media; sending text only",
      );
    }

    const finalText = stripped.text || reply.text;

    // Check if alerts are disabled for WhatsApp
    if (!visibility.showAlerts) {
      heartbeatLogger.info({ reason: "alerts-disabled", to: redactedTo }, "heartbeat skipped");
      emitHeartbeatEvent({
        channel: "whatsapp",
        hasMedia,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
        preview: finalText.slice(0, 200),
        reason: "alerts-disabled",
        status: "skipped",
        to,
      });
      return;
    }

    if (dryRun) {
      heartbeatLogger.info(
        { chars: finalText.length, reason: "dry-run", to: redactedTo },
        "heartbeat dry-run",
      );
      whatsappHeartbeatLog.info(`[dry-run] heartbeat -> ${redactedTo} (${finalText.length} chars)`);
      return;
    }

    const sendResult = await sender(to, finalText, { verbose });
    emitHeartbeatEvent({
      channel: "whatsapp",
      hasMedia,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
      preview: finalText.slice(0, 160),
      status: "sent",
      to,
    });
    heartbeatLogger.info(
      {
        chars: finalText.length,
        messageId: sendResult.messageId,
        to: redactedTo,
      },
      "heartbeat sent",
    );
    whatsappHeartbeatLog.info(`heartbeat alert sent to ${redactedTo}`);
  } catch (error) {
    const reason = formatError(error);
    heartbeatLogger.warn({ error: reason, to: redactedTo }, "heartbeat failed");
    whatsappHeartbeatLog.warn(`heartbeat failed (${reason})`);
    emitHeartbeatEvent({
      channel: "whatsapp",
      indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
      reason,
      status: "failed",
      to,
    });
    throw error;
  }
}

export function resolveHeartbeatRecipients(
  cfg: ReturnType<typeof loadConfig>,
  opts: { to?: string; all?: boolean; accountId?: string } = {},
) {
  return resolveWhatsAppHeartbeatRecipients(cfg, opts);
}
