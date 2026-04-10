import crypto from "node:crypto";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  type ThinkLevel,
  type VerboseLevel,
  normalizeThinkLevel,
  normalizeVerboseLevel,
} from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  type SessionEntry,
  evaluateSessionFreshness,
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveChannelResetConfig,
  resolveExplicitAgentSessionKey,
  resolveSessionKey,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveStorePath,
} from "../../config/sessions.js";
import { normalizeAgentId, normalizeMainKey } from "../../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../../sessions/session-id-resolution.js";
import { listAgentIds } from "../agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../bootstrap-cache.js";

export interface SessionResolution {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  isNewSession: boolean;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
}

interface SessionKeyResolution {
  sessionKey?: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
}

interface SessionIdMatchSet {
  matches: [string, SessionEntry][];
  primaryStoreMatches: [string, SessionEntry][];
  storeByKey: Map<string, SessionKeyResolution>;
}

function buildExplicitSessionIdSessionKey(params: { sessionId: string; agentId?: string }): string {
  return `agent:${normalizeAgentId(params.agentId)}:explicit:${params.sessionId.trim()}`;
}

function collectSessionIdMatchesForRequest(opts: {
  cfg: OpenClawConfig;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  storeAgentId?: string;
  sessionId: string;
}): SessionIdMatchSet {
  const matches: [string, SessionEntry][] = [];
  const primaryStoreMatches: [string, SessionEntry][] = [];
  const storeByKey = new Map<string, SessionKeyResolution>();

  const addMatches = (
    candidateStore: Record<string, SessionEntry>,
    candidateStorePath: string,
    options?: { primary?: boolean },
  ): void => {
    for (const [candidateKey, candidateEntry] of Object.entries(candidateStore)) {
      if (candidateEntry?.sessionId !== opts.sessionId) {
        continue;
      }
      matches.push([candidateKey, candidateEntry]);
      if (options?.primary) {
        primaryStoreMatches.push([candidateKey, candidateEntry]);
      }
      storeByKey.set(candidateKey, {
        sessionKey: candidateKey,
        sessionStore: candidateStore,
        storePath: candidateStorePath,
      });
    }
  };

  addMatches(opts.sessionStore, opts.storePath, { primary: true });
  for (const agentId of listAgentIds(opts.cfg)) {
    if (agentId === opts.storeAgentId) {
      continue;
    }
    const candidateStorePath = resolveStorePath(opts.cfg.session?.store, { agentId });
    addMatches(loadSessionStore(candidateStorePath), candidateStorePath);
  }

  return { matches, primaryStoreMatches, storeByKey };
}

/**
 * Resolve an existing stored session key for a session id from a specific agent store.
 * This scopes the lookup to the target store without implicitly converting `agentId`
 * into that agent's main session key.
 */
export function resolveStoredSessionKeyForSessionId(opts: {
  cfg: OpenClawConfig;
  sessionId: string;
  agentId?: string;
}): SessionKeyResolution {
  const sessionId = opts.sessionId.trim();
  const storeAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined;
  const storePath = resolveStorePath(opts.cfg.session?.store, {
    agentId: storeAgentId,
  });
  const sessionStore = loadSessionStore(storePath);
  if (!sessionId) {
    return { sessionKey: undefined, sessionStore, storePath };
  }

  const selection = resolveSessionIdMatchSelection(
    Object.entries(sessionStore).filter(([, entry]) => entry?.sessionId === sessionId),
    sessionId,
  );
  return {
    sessionKey: selection.kind === "selected" ? selection.sessionKey : undefined,
    sessionStore,
    storePath,
  };
}

export function resolveSessionKeyForRequest(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionKeyResolution {
  const sessionCfg = opts.cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const explicitSessionKey =
    opts.sessionKey?.trim() ||
    resolveExplicitAgentSessionKey({
      agentId: opts.agentId,
      cfg: opts.cfg,
    });
  const storeAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const sessionStore = loadSessionStore(storePath);

  const ctx: MsgContext | undefined = opts.to?.trim() ? { From: opts.to } : undefined;
  let sessionKey: string | undefined =
    explicitSessionKey ?? (ctx ? resolveSessionKey(scope, ctx, mainKey) : undefined);

  // If a session id was provided, prefer to re-use its existing entry (by id) even when no key was
  // Derived. When duplicates exist across agent stores, pick the same deterministic best match used
  // By the shared gateway/session resolver helpers instead of whichever store happens to be scanned
  // First.
  if (
    opts.sessionId &&
    !explicitSessionKey &&
    (!sessionKey || sessionStore[sessionKey]?.sessionId !== opts.sessionId)
  ) {
    const { matches, primaryStoreMatches, storeByKey } = collectSessionIdMatchesForRequest({
      cfg: opts.cfg,
      sessionId: opts.sessionId,
      sessionStore,
      storeAgentId,
      storePath,
    });
    const preferredSelection = resolveSessionIdMatchSelection(matches, opts.sessionId);
    const currentStoreSelection =
      preferredSelection.kind === "selected"
        ? preferredSelection
        : resolveSessionIdMatchSelection(primaryStoreMatches, opts.sessionId);
    if (currentStoreSelection.kind === "selected") {
      const preferred = storeByKey.get(currentStoreSelection.sessionKey);
      if (preferred) {
        return preferred;
      }
      ({ sessionKey } = currentStoreSelection);
    }
  }

  if (opts.sessionId && !sessionKey) {
    sessionKey = buildExplicitSessionIdSessionKey({
      agentId: opts.agentId,
      sessionId: opts.sessionId,
    });
  }

  return { sessionKey, sessionStore, storePath };
}

export function resolveSession(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionResolution {
  const sessionCfg = opts.cfg.session;
  const { sessionKey, sessionStore, storePath } = resolveSessionKeyForRequest({
    agentId: opts.agentId,
    cfg: opts.cfg,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    to: opts.to,
  });
  const now = Date.now();

  const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;

  const resetType = resolveSessionResetType({ sessionKey });
  const channelReset = resolveChannelResetConfig({
    channel: sessionEntry?.lastChannel ?? sessionEntry?.channel ?? sessionEntry?.origin?.provider,
    sessionCfg,
  });
  const resetPolicy = resolveSessionResetPolicy({
    resetOverride: channelReset,
    resetType,
    sessionCfg,
  });
  const fresh = sessionEntry
    ? evaluateSessionFreshness({ now, policy: resetPolicy, updatedAt: sessionEntry.updatedAt })
        .fresh
    : false;
  const sessionId =
    opts.sessionId?.trim() || (fresh ? sessionEntry?.sessionId : undefined) || crypto.randomUUID();
  const isNewSession = !fresh && !opts.sessionId;

  clearBootstrapSnapshotOnSessionRollover({
    previousSessionId: isNewSession ? sessionEntry?.sessionId : undefined,
    sessionKey,
  });

  const persistedThinking =
    fresh && sessionEntry?.thinkingLevel
      ? normalizeThinkLevel(sessionEntry.thinkingLevel)
      : undefined;
  const persistedVerbose =
    fresh && sessionEntry?.verboseLevel
      ? normalizeVerboseLevel(sessionEntry.verboseLevel)
      : undefined;

  return {
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionEntry,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
  };
}
