import { normalizeMainKey } from "openclaw/plugin-sdk/routing";
import {
  evaluateSessionFreshness,
  loadSessionStore,
  resolveChannelResetConfig,
  resolveSessionKey,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveStorePath,
  resolveThreadFlag,
} from "./config.runtime.js";

type LoadConfigFn = typeof import("./config.runtime.js").loadConfig;

export function getSessionSnapshot(
  cfg: ReturnType<LoadConfigFn>,
  from: string,
  _isHeartbeat = false,
  ctx?: {
    sessionKey?: string | null;
    isGroup?: boolean;
    messageThreadId?: string | number | null;
    threadLabel?: string | null;
    threadStarterBody?: string | null;
    parentSessionKey?: string | null;
  },
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const key =
    ctx?.sessionKey?.trim() ??
    resolveSessionKey(
      scope,
      { Body: "", From: from, To: "" },
      normalizeMainKey(sessionCfg?.mainKey),
    );
  const store = loadSessionStore(resolveStorePath(sessionCfg?.store));
  const entry = store[key];

  const isThread = resolveThreadFlag({
    messageThreadId: ctx?.messageThreadId ?? null,
    parentSessionKey: ctx?.parentSessionKey ?? null,
    sessionKey: key,
    threadLabel: ctx?.threadLabel ?? null,
    threadStarterBody: ctx?.threadStarterBody ?? null,
  });
  const resetType = resolveSessionResetType({ isGroup: ctx?.isGroup, isThread, sessionKey: key });
  const channelReset = resolveChannelResetConfig({
    channel: entry?.lastChannel ?? entry?.channel,
    sessionCfg,
  });
  const resetPolicy = resolveSessionResetPolicy({
    resetOverride: channelReset,
    resetType,
    sessionCfg,
  });
  const now = Date.now();
  const freshness = entry
    ? evaluateSessionFreshness({ now, policy: resetPolicy, updatedAt: entry.updatedAt })
    : { fresh: false };
  return {
    dailyResetAt: freshness.dailyResetAt,
    entry,
    fresh: freshness.fresh,
    idleExpiresAt: freshness.idleExpiresAt,
    key,
    resetPolicy,
    resetType,
  };
}
