import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import type { SessionScope } from "../../config/sessions/types.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";

export function resolveCronAgentSessionKey(params: {
  sessionKey: string;
  agentId: string;
  mainKey?: string | undefined;
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
}): string {
  const raw = toAgentStoreSessionKey({
    agentId: params.agentId,
    mainKey: params.mainKey,
    requestKey: params.sessionKey.trim(),
  });
  // Canonicalize so "agent:<id>:main" → "agent:<id>:<configuredMainKey>"
  // When cfg.session.mainKey differs from "main". Without this, cron sessions
  // Are orphaned when read paths use the configured mainKey alias (#29683).
  return canonicalizeMainSessionAlias({
    agentId: params.agentId,
    cfg: params.cfg,
    sessionKey: raw,
  });
}
