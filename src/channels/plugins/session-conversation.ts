import { tryLoadActivatedBundledPluginPublicSurfaceModuleSync } from "../../plugin-sdk/facade-runtime.js";
import {
  type ParsedThreadSessionSuffix,
  type RawSessionConversationRef,
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeChannelId as normalizeChatChannelId } from "../registry.js";
import { getLoadedChannelPlugin, normalizeChannelId as normalizeAnyChannelId } from "./registry.js";

export interface ResolvedSessionConversation {
  id: string;
  threadId: string | undefined;
  baseConversationId: string;
  parentConversationCandidates: string[];
}

export interface ResolvedSessionConversationRef {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
  id: string;
  threadId: string | undefined;
  baseSessionKey: string;
  baseConversationId: string;
  parentConversationCandidates: string[];
}

interface SessionConversationHookResult {
  id: string;
  threadId?: string | null;
  baseConversationId?: string | null;
  parentConversationCandidates?: string[];
}

interface SessionConversationResolverParams {
  kind: "group" | "channel";
  rawId: string;
}

interface BundledSessionKeyModule {
  resolveSessionConversation?: (
    params: SessionConversationResolverParams,
  ) => SessionConversationHookResult | null;
}

const SESSION_KEY_API_ARTIFACT_BASENAME = "session-key-api.js";

type NormalizedSessionConversationResolution = ResolvedSessionConversation & {
  hasExplicitParentConversationCandidates: boolean;
};

function normalizeResolvedChannel(channel: string): string {
  return (
    normalizeAnyChannelId(channel) ??
    normalizeChatChannelId(channel) ??
    normalizeOptionalLowercaseString(channel) ??
    ""
  );
}

function getMessagingAdapter(channel: string) {
  const normalizedChannel = normalizeResolvedChannel(channel);
  try {
    return getLoadedChannelPlugin(normalizedChannel)?.messaging;
  } catch {
    return undefined;
  }
}

function dedupeConversationIds(values: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    resolved.push(trimmed);
  }
  return resolved;
}

function buildGenericConversationResolution(rawId: string): ResolvedSessionConversation | null {
  const trimmed = rawId.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseThreadSessionSuffix(trimmed);
  const id = (parsed.baseSessionKey ?? trimmed).trim();
  if (!id) {
    return null;
  }

  return {
    baseConversationId: id,
    id,
    parentConversationCandidates: dedupeConversationIds(
      parsed.threadId ? [parsed.baseSessionKey] : [],
    ),
    threadId: parsed.threadId,
  };
}

function normalizeSessionConversationResolution(
  resolved: SessionConversationHookResult | null | undefined,
): NormalizedSessionConversationResolution | null {
  if (!resolved?.id?.trim()) {
    return null;
  }

  return {
    baseConversationId:
      normalizeOptionalString(resolved.baseConversationId) ??
      dedupeConversationIds(resolved.parentConversationCandidates ?? []).at(-1) ??
      resolved.id.trim(),
    hasExplicitParentConversationCandidates: Object.hasOwn(
      resolved,
      "parentConversationCandidates",
    ),
    id: resolved.id.trim(),
    parentConversationCandidates: dedupeConversationIds(
      resolved.parentConversationCandidates ?? [],
    ),
    threadId: normalizeOptionalString(resolved.threadId),
  };
}

function resolveBundledSessionConversationFallback(params: {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
}): NormalizedSessionConversationResolution | null {
  const dirName = normalizeResolvedChannel(params.channel);
  let resolveSessionConversation: BundledSessionKeyModule["resolveSessionConversation"];
  try {
    resolveSessionConversation =
      tryLoadActivatedBundledPluginPublicSurfaceModuleSync<BundledSessionKeyModule>({
        artifactBasename: SESSION_KEY_API_ARTIFACT_BASENAME,
        dirName,
      })?.resolveSessionConversation;
  } catch {
    return null;
  }
  if (typeof resolveSessionConversation !== "function") {
    return null;
  }

  return normalizeSessionConversationResolution(
    resolveSessionConversation({
      kind: params.kind,
      rawId: params.rawId,
    }),
  );
}

function resolveSessionConversationResolution(params: {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
}): ResolvedSessionConversation | null {
  const rawId = params.rawId.trim();
  if (!rawId) {
    return null;
  }

  const messaging = getMessagingAdapter(params.channel);
  const pluginResolved = normalizeSessionConversationResolution(
    messaging?.resolveSessionConversation?.({
      kind: params.kind,
      rawId,
    }),
  );
  const resolved =
    pluginResolved ??
    resolveBundledSessionConversationFallback({
      channel: params.channel,
      kind: params.kind,
      rawId,
    }) ??
    buildGenericConversationResolution(rawId);
  if (!resolved) {
    return null;
  }

  const parentConversationCandidates = dedupeConversationIds(
    pluginResolved?.hasExplicitParentConversationCandidates
      ? resolved.parentConversationCandidates
      : (messaging?.resolveParentConversationCandidates?.({
          kind: params.kind,
          rawId,
        }) ?? resolved.parentConversationCandidates),
  );
  const baseConversationId =
    parentConversationCandidates.at(-1) ?? resolved.baseConversationId ?? resolved.id;

  return {
    ...resolved,
    baseConversationId,
    parentConversationCandidates,
  };
}

export function resolveSessionConversation(params: {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
}): ResolvedSessionConversation | null {
  return resolveSessionConversationResolution(params);
}

function buildBaseSessionKey(raw: RawSessionConversationRef, id: string): string {
  return `${raw.prefix}:${id}`;
}

export function resolveSessionConversationRef(
  sessionKey: string | undefined | null,
): ResolvedSessionConversationRef | null {
  const raw = parseRawSessionConversationRef(sessionKey);
  if (!raw) {
    return null;
  }

  const resolved = resolveSessionConversation(raw);
  if (!resolved) {
    return null;
  }

  return {
    baseConversationId: resolved.baseConversationId,
    baseSessionKey: buildBaseSessionKey(raw, resolved.id),
    channel: normalizeResolvedChannel(raw.channel),
    id: resolved.id,
    kind: raw.kind,
    parentConversationCandidates: resolved.parentConversationCandidates,
    rawId: raw.rawId,
    threadId: resolved.threadId,
  };
}

export function resolveSessionThreadInfo(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix {
  const resolved = resolveSessionConversationRef(sessionKey);
  if (!resolved) {
    return parseThreadSessionSuffix(sessionKey);
  }

  return {
    baseSessionKey: resolved.threadId
      ? resolved.baseSessionKey
      : normalizeOptionalString(sessionKey),
    threadId: resolved.threadId,
  };
}

export function resolveSessionParentSessionKey(
  sessionKey: string | undefined | null,
): string | null {
  const { baseSessionKey, threadId } = resolveSessionThreadInfo(sessionKey);
  if (!threadId) {
    return null;
  }
  return baseSessionKey ?? null;
}
