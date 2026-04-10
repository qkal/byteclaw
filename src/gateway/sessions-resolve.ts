import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  ErrorCodes,
  type ErrorShape,
  type SessionsResolveParams,
  errorShape,
} from "./protocol/index.js";
import {
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  migrateAndPruneGatewaySessionStoreKey,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

export type SessionsResolveResult = { ok: true; key: string } | { ok: false; error: ErrorShape };

function resolveSessionVisibilityFilterOptions(p: SessionsResolveParams) {
  return {
    agentId: p.agentId,
    includeGlobal: p.includeGlobal === true,
    includeUnknown: p.includeUnknown === true,
    spawnedBy: p.spawnedBy,
  };
}

function noSessionFoundResult(key: string): SessionsResolveResult {
  return {
    error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${key}`),
    ok: false,
  };
}

function isResolvedSessionKeyVisible(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
  storePath: string;
  store: ReturnType<typeof loadSessionStore>;
  key: string;
}) {
  if (typeof params.p.spawnedBy !== "string" || params.p.spawnedBy.trim().length === 0) {
    return true;
  }
  return listSessionsFromStore({
    cfg: params.cfg,
    opts: resolveSessionVisibilityFilterOptions(params.p),
    store: params.store,
    storePath: params.storePath,
  }).sessions.some((session) => session.key === params.key);
}

export async function resolveSessionKeyFromResolveParams(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
}): Promise<SessionsResolveResult> {
  const { cfg, p } = params;

  const key = normalizeOptionalString(p.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeOptionalString(p.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasLabel = (normalizeOptionalString(p.label) ?? "").length > 0;
  const selectionCount = [hasKey, hasSessionId, hasLabel].filter(Boolean).length;
  if (selectionCount > 1) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Provide either key, sessionId, or label (not multiple)",
      ),
      ok: false,
    };
  }
  if (selectionCount === 0) {
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, "Either key, sessionId, or label is required"),
      ok: false,
    };
  }

  if (hasKey) {
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const store = loadSessionStore(target.storePath);
    if (store[target.canonicalKey]) {
      if (
        !isResolvedSessionKeyVisible({
          cfg,
          key: target.canonicalKey,
          p,
          store,
          storePath: target.storePath,
        })
      ) {
        return noSessionFoundResult(key);
      }
      return { key: target.canonicalKey, ok: true };
    }
    const legacyKey = target.storeKeys.find((candidate) => store[candidate]);
    if (!legacyKey) {
      return noSessionFoundResult(key);
    }
    await updateSessionStore(target.storePath, (s) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store: s });
      if (!s[primaryKey] && s[legacyKey]) {
        s[primaryKey] = s[legacyKey];
      }
    });
    if (
      !isResolvedSessionKeyVisible({
        cfg,
        key: target.canonicalKey,
        p,
        store: loadSessionStore(target.storePath),
        storePath: target.storePath,
      })
    ) {
      return noSessionFoundResult(key);
    }
    return { key: target.canonicalKey, ok: true };
  }

  if (hasSessionId) {
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const list = listSessionsFromStore({
      cfg,
      opts: {
        agentId: p.agentId,
        includeGlobal: p.includeGlobal === true,
        includeUnknown: p.includeUnknown === true,
        spawnedBy: p.spawnedBy,
      },
      store,
      storePath,
    });
    const matches = list.sessions.filter(
      (session) => session.sessionId === sessionId || session.key === sessionId,
    );
    if (matches.length === 0) {
      return {
        error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${sessionId}`),
        ok: false,
      };
    }
    if (matches.length > 1) {
      const keys = matches.map((session) => session.key).join(", ");
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found for sessionId: ${sessionId} (${keys})`,
        ),
        ok: false,
      };
    }
    return { key: String(matches[0]?.key ?? ""), ok: true };
  }

  const parsedLabel = parseSessionLabel(p.label);
  if (!parsedLabel.ok) {
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error),
      ok: false,
    };
  }

  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
  const list = listSessionsFromStore({
    cfg,
    opts: {
      agentId: p.agentId,
      includeGlobal: p.includeGlobal === true,
      includeUnknown: p.includeUnknown === true,
      label: parsedLabel.label,
      limit: 2,
      spawnedBy: p.spawnedBy,
    },
    store,
    storePath,
  });
  if (list.sessions.length === 0) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `No session found with label: ${parsedLabel.label}`,
      ),
      ok: false,
    };
  }
  if (list.sessions.length > 1) {
    const keys = list.sessions.map((s) => s.key).join(", ");
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Multiple sessions found with label: ${parsedLabel.label} (${keys})`,
      ),
      ok: false,
    };
  }

  return { key: String(list.sessions[0]?.key ?? ""), ok: true };
}
