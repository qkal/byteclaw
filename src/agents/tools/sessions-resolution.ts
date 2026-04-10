import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isAcpSessionKey, normalizeMainKey } from "../../routing/session-key.js";
import { looksLikeSessionId } from "../../sessions/session-id.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type GatewayCaller = typeof callGateway;

const defaultSessionsResolutionDeps = {
  callGateway,
};

let sessionsResolutionDeps: {
  callGateway: GatewayCaller;
} = defaultSessionsResolutionDeps;

export function resolveMainSessionAlias(cfg: OpenClawConfig) {
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const alias = scope === "global" ? "global" : mainKey;
  return { alias, mainKey, scope };
}

export function resolveDisplaySessionKey(params: { key: string; alias: string; mainKey: string }) {
  if (params.key === params.alias) {
    return "main";
  }
  if (params.key === params.mainKey) {
    return "main";
  }
  return params.key;
}

export function resolveInternalSessionKey(params: {
  key: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
}) {
  if (params.key === "current") {
    return params.requesterInternalKey ?? params.key;
  }
  if (params.key === "main") {
    return params.alias;
  }
  return params.key;
}

export async function listSpawnedSessionKeys(params: {
  requesterSessionKey: string;
  limit?: number;
}): Promise<Set<string>> {
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : undefined;
  try {
    const list = await sessionsResolutionDeps.callGateway<{ sessions: { key?: unknown }[] }>({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        ...(limit !== undefined ? { limit } : {}),
        spawnedBy: params.requesterSessionKey,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    const keys = sessions.map((entry) => normalizeOptionalString(entry?.key) ?? "").filter(Boolean);
    return new Set(keys);
  } catch {
    return new Set();
  }
}

export async function isRequesterSpawnedSessionVisible(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
  limit?: number;
}): Promise<boolean> {
  if (params.requesterSessionKey === params.targetSessionKey) {
    return true;
  }
  try {
    const resolved = await sessionsResolutionDeps.callGateway<{ key?: string }>({
      method: "sessions.resolve",
      params: {
        key: params.targetSessionKey,
        spawnedBy: params.requesterSessionKey,
      },
    });
    if (typeof resolved?.key === "string" && resolved.key.trim() === params.targetSessionKey) {
      return true;
    }
  } catch {
    // Fall back to the spawned-session listing path below.
  }
  const keys = await listSpawnedSessionKeys({
    limit: params.limit,
    requesterSessionKey: params.requesterSessionKey,
  });
  return keys.has(params.targetSessionKey);
}

export function shouldVerifyRequesterSpawnedSessionVisibility(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
  restrictToSpawned: boolean;
  resolvedViaSessionId: boolean;
}): boolean {
  return (
    params.restrictToSpawned &&
    !params.resolvedViaSessionId &&
    params.requesterSessionKey !== params.targetSessionKey
  );
}

export async function isResolvedSessionVisibleToRequester(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
  restrictToSpawned: boolean;
  resolvedViaSessionId: boolean;
  limit?: number;
}): Promise<boolean> {
  if (
    !shouldVerifyRequesterSpawnedSessionVisibility({
      requesterSessionKey: params.requesterSessionKey,
      resolvedViaSessionId: params.resolvedViaSessionId,
      restrictToSpawned: params.restrictToSpawned,
      targetSessionKey: params.targetSessionKey,
    })
  ) {
    return true;
  }
  return await isRequesterSpawnedSessionVisible({
    limit: params.limit,
    requesterSessionKey: params.requesterSessionKey,
    targetSessionKey: params.targetSessionKey,
  });
}

export { looksLikeSessionId };

export function looksLikeSessionKey(value: string): boolean {
  const raw = normalizeOptionalString(value) ?? "";
  if (!raw) {
    return false;
  }
  // These are canonical key shapes that should never be treated as sessionIds.
  if (raw === "main" || raw === "global" || raw === "unknown" || raw === "current") {
    return true;
  }
  if (isAcpSessionKey(raw)) {
    return true;
  }
  if (raw.startsWith("agent:")) {
    return true;
  }
  if (raw.startsWith("cron:") || raw.startsWith("hook:")) {
    return true;
  }
  if (raw.startsWith("node-") || raw.startsWith("node:")) {
    return true;
  }
  if (raw.includes(":group:") || raw.includes(":channel:")) {
    return true;
  }
  return false;
}

export function shouldResolveSessionIdInput(value: string): boolean {
  // Treat anything that doesn't look like a well-formed key as a sessionId candidate.
  return looksLikeSessionId(value) || !looksLikeSessionKey(value);
}

export type SessionReferenceResolution =
  | {
      ok: true;
      key: string;
      displayKey: string;
      resolvedViaSessionId: boolean;
    }
  | { ok: false; status: "error" | "forbidden"; error: string };

export type VisibleSessionReferenceResolution =
  | {
      ok: true;
      key: string;
      displayKey: string;
    }
  | {
      ok: false;
      status: "forbidden";
      error: string;
      displayKey: string;
    };

function buildResolvedSessionReference(params: {
  key: string;
  alias: string;
  mainKey: string;
  resolvedViaSessionId: boolean;
}): Extract<SessionReferenceResolution, { ok: true }> {
  return {
    displayKey: resolveDisplaySessionKey({
      alias: params.alias,
      key: params.key,
      mainKey: params.mainKey,
    }),
    key: params.key,
    ok: true,
    resolvedViaSessionId: params.resolvedViaSessionId,
  };
}

function buildSessionIdResolveParams(params: {
  sessionId: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}) {
  return {
    includeGlobal: !params.restrictToSpawned,
    includeUnknown: !params.restrictToSpawned,
    sessionId: params.sessionId,
    spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
  };
}

async function callGatewayResolveSessionId(params: {
  sessionId: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<string> {
  const result = await sessionsResolutionDeps.callGateway<{ key?: string }>({
    method: "sessions.resolve",
    params: buildSessionIdResolveParams(params),
  });
  const key = normalizeOptionalString(result?.key) ?? "";
  if (!key) {
    throw new Error(
      `Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`,
    );
  }
  return key;
}

async function resolveSessionKeyFromSessionId(params: {
  sessionId: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution> {
  try {
    // Resolve via gateway so we respect store routing and visibility rules.
    const key = await callGatewayResolveSessionId(params);
    return buildResolvedSessionReference({
      alias: params.alias,
      key,
      mainKey: params.mainKey,
      resolvedViaSessionId: true,
    });
  } catch (error) {
    if (params.restrictToSpawned) {
      return {
        error: `Session not visible from this sandboxed agent session: ${params.sessionId}`,
        ok: false,
        status: "forbidden",
      };
    }
    const message = formatErrorMessage(error);
    return {
      error:
        message ||
        `Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`,
      ok: false,
      status: "error",
    };
  }
}

async function resolveSessionKeyFromKey(params: {
  key: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution | null> {
  try {
    // Try key-based resolution first so non-standard keys keep working.
    const result = await sessionsResolutionDeps.callGateway<{ key?: string }>({
      method: "sessions.resolve",
      params: {
        key: params.key,
        spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
      },
    });
    const key = normalizeOptionalString(result?.key) ?? "";
    if (!key) {
      return null;
    }
    return buildResolvedSessionReference({
      alias: params.alias,
      key,
      mainKey: params.mainKey,
      resolvedViaSessionId: false,
    });
  } catch {
    return null;
  }
}

async function tryResolveSessionKeyFromSessionId(params: {
  sessionId: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<Extract<SessionReferenceResolution, { ok: true }> | null> {
  try {
    const key = await callGatewayResolveSessionId(params);
    return buildResolvedSessionReference({
      alias: params.alias,
      key,
      mainKey: params.mainKey,
      resolvedViaSessionId: true,
    });
  } catch {
    return null;
  }
}

async function resolveSessionReferenceByKeyOrSessionId(params: {
  raw: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowUnresolvedSessionId: boolean;
  skipKeyLookup?: boolean;
  forceSessionIdLookup?: boolean;
}): Promise<SessionReferenceResolution | null> {
  if (!params.skipKeyLookup) {
    // Prefer key resolution to avoid misclassifying custom keys as sessionIds.
    const resolvedByKey = await resolveSessionKeyFromKey({
      alias: params.alias,
      key: params.raw,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
    });
    if (resolvedByKey) {
      return resolvedByKey;
    }
  }
  if (!(params.forceSessionIdLookup || shouldResolveSessionIdInput(params.raw))) {
    return null;
  }
  if (params.allowUnresolvedSessionId) {
    return await tryResolveSessionKeyFromSessionId({
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
      sessionId: params.raw,
    });
  }
  return await resolveSessionKeyFromSessionId({
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
    restrictToSpawned: params.restrictToSpawned,
    sessionId: params.raw,
  });
}

export async function resolveSessionReference(params: {
  sessionKey: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution> {
  const rawInput = params.sessionKey.trim();
  if (rawInput === "current") {
    const resolvedCurrent = await resolveSessionReferenceByKeyOrSessionId({
      alias: params.alias,
      allowUnresolvedSessionId: true,
      forceSessionIdLookup: true,
      mainKey: params.mainKey,
      raw: rawInput,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
      skipKeyLookup: params.restrictToSpawned,
    });
    if (resolvedCurrent) {
      return resolvedCurrent;
    }
  }
  const raw =
    rawInput === "current" && params.requesterInternalKey ? params.requesterInternalKey : rawInput;
  if (shouldResolveSessionIdInput(raw)) {
    const resolvedByGateway = await resolveSessionReferenceByKeyOrSessionId({
      alias: params.alias,
      allowUnresolvedSessionId: false,
      mainKey: params.mainKey,
      raw,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
    });
    if (resolvedByGateway) {
      return resolvedByGateway;
    }
  }

  const resolvedKey = resolveInternalSessionKey({
    alias: params.alias,
    key: raw,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
  });
  const displayKey = resolveDisplaySessionKey({
    alias: params.alias,
    key: resolvedKey,
    mainKey: params.mainKey,
  });
  return { displayKey, key: resolvedKey, ok: true, resolvedViaSessionId: false };
}

export async function resolveVisibleSessionReference(params: {
  resolvedSession: Extract<SessionReferenceResolution, { ok: true }>;
  requesterSessionKey: string;
  restrictToSpawned: boolean;
  visibilitySessionKey: string;
}): Promise<VisibleSessionReferenceResolution> {
  const resolvedKey = params.resolvedSession.key;
  const {displayKey} = params.resolvedSession;
  const visible = await isResolvedSessionVisibleToRequester({
    requesterSessionKey: params.requesterSessionKey,
    resolvedViaSessionId: params.resolvedSession.resolvedViaSessionId,
    restrictToSpawned: params.restrictToSpawned,
    targetSessionKey: resolvedKey,
  });
  if (!visible) {
    return {
      displayKey,
      error: `Session not visible from this sandboxed agent session: ${params.visibilitySessionKey}`,
      ok: false,
      status: "forbidden",
    };
  }
  return { displayKey, key: resolvedKey, ok: true };
}

export const normalizeOptionalKey: (value?: string) => string | undefined = normalizeOptionalString;

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    sessionsResolutionDeps = overrides
      ? {
          ...defaultSessionsResolutionDeps,
          ...overrides,
        }
      : defaultSessionsResolutionDeps;
  },
};
