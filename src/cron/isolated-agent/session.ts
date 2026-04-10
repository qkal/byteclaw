import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
} from "../../config/sessions/reset.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";

export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
  forceNew?: boolean;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];

  // Check if we can reuse an existing session
  let sessionId: string;
  let isNewSession: boolean;
  let systemSent: boolean;

  if (!params.forceNew && entry?.sessionId) {
    // Evaluate freshness using the configured reset policy
    // Cron/webhook sessions use "direct" reset type (1:1 conversation style)
    const resetPolicy = resolveSessionResetPolicy({
      resetType: "direct",
      sessionCfg,
    });
    const freshness = evaluateSessionFreshness({
      now: params.nowMs,
      policy: resetPolicy,
      updatedAt: entry.updatedAt,
    });

    if (freshness.fresh) {
      // Reuse existing session
      ({ sessionId } = entry);
      isNewSession = false;
      systemSent = entry.systemSent ?? false;
    } else {
      // Session expired, create new
      sessionId = crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
    }
  } else {
    // No existing session or forced new
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
  }

  clearBootstrapSnapshotOnSessionRollover({
    previousSessionId: isNewSession ? entry?.sessionId : undefined,
    sessionKey: params.sessionKey,
  });

  const sessionEntry: SessionEntry = {
    // Preserve existing per-session overrides even when rolling to a new sessionId.
    ...entry,
    // Always update these core fields
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
    // When starting a fresh session (forceNew / isolated), clear delivery routing
    // State inherited from prior sessions. Without this, lastThreadId leaks into
    // The new session and causes announce-mode cron deliveries to post as thread
    // Replies instead of channel top-level messages.
    // DeliveryContext must also be cleared because normalizeSessionEntryDelivery
    // Repopulates lastThreadId from deliveryContext.threadId on store writes.
    ...(isNewSession && {
      deliveryContext: undefined,
      lastAccountId: undefined,
      lastChannel: undefined,
      lastThreadId: undefined,
      lastTo: undefined,
    }),
  };
  return { isNewSession, sessionEntry, store, storePath, systemSent };
}
