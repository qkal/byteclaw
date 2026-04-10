import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
  ChannelId,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type RuntimeEnv, defaultRuntime } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { DirectoryCache, buildDirectoryCacheKey } from "./directory-cache.js";
import { ambiguousTargetError, unknownTargetError } from "./target-errors.js";
import {
  buildTargetResolverSignature,
  looksLikeTargetId,
  maybeResolvePluginMessagingTarget,
  normalizeChannelTargetInput,
  normalizeTargetForProvider,
  resolveNormalizedTargetInput,
} from "./target-normalization.js";

export type TargetResolveKind = ChannelDirectoryEntryKind | "channel";

export type ResolveAmbiguousMode = "error" | "best" | "first";

export interface ResolvedMessagingTarget {
  to: string;
  kind: TargetResolveKind;
  display?: string;
  source: "normalized" | "directory";
}

export type ResolveMessagingTargetResult =
  | { ok: true; target: ResolvedMessagingTarget }
  | { ok: false; error: Error; candidates?: ChannelDirectoryEntry[] };

function asResolvedMessagingTarget(
  target: Awaited<ReturnType<typeof maybeResolvePluginMessagingTarget>>,
): ResolvedMessagingTarget | undefined {
  return target;
}

export async function resolveChannelTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKind;
  runtime?: RuntimeEnv;
}): Promise<ResolveMessagingTargetResult> {
  return resolveMessagingTarget(params);
}

export async function maybeResolveIdLikeTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKind;
}): Promise<ResolvedMessagingTarget | undefined> {
  return asResolvedMessagingTarget(
    await maybeResolvePluginMessagingTarget({
      ...params,
      requireIdLike: true,
    }),
  );
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const directoryCache = new DirectoryCache<ChannelDirectoryEntry[]>(CACHE_TTL_MS);

export function resetDirectoryCache(params?: { channel?: ChannelId; accountId?: string | null }) {
  if (!params?.channel) {
    directoryCache.clear();
    return;
  }
  const channelKey = params.channel;
  const accountKey = params.accountId ?? "default";
  directoryCache.clearMatching((key) => {
    if (!key.startsWith(`${channelKey}:`)) {
      return false;
    }
    if (!params.accountId) {
      return true;
    }
    return key.startsWith(`${channelKey}:${accountKey}:`);
  });
}

function normalizeQuery(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function stripTargetPrefixes(value: string): string {
  return value
    .replace(/^(channel|user):/i, "")
    .replace(/^[@#]/, "")
    .trim();
}

export function formatTargetDisplay(params: {
  channel: ChannelId;
  target: string;
  display?: string;
  kind?: ChannelDirectoryEntryKind;
}): string {
  const plugin = getChannelPlugin(params.channel);
  if (plugin?.messaging?.formatTargetDisplay) {
    return plugin.messaging.formatTargetDisplay({
      display: params.display,
      kind: params.kind,
      target: params.target,
    });
  }

  const trimmedTarget = params.target.trim();
  const lowered = normalizeLowercaseStringOrEmpty(trimmedTarget);
  const display = params.display?.trim();
  const kind =
    params.kind ??
    (lowered.startsWith("user:") ? "user" : (lowered.startsWith("channel:") ? "group" : undefined));

  if (display) {
    if (display.startsWith("#") || display.startsWith("@")) {
      return display;
    }
    if (kind === "user") {
      return `@${display}`;
    }
    if (kind === "group" || kind === "channel") {
      return `#${display}`;
    }
    return display;
  }

  if (!trimmedTarget) {
    return trimmedTarget;
  }
  if (trimmedTarget.startsWith("#") || trimmedTarget.startsWith("@")) {
    return trimmedTarget;
  }

  const channelPrefix = `${params.channel}:`;
  const withoutProvider = lowered.startsWith(channelPrefix)
    ? trimmedTarget.slice(channelPrefix.length)
    : trimmedTarget;

  if (/^channel:/i.test(withoutProvider)) {
    return `#${withoutProvider.replace(/^channel:/i, "")}`;
  }
  if (/^user:/i.test(withoutProvider)) {
    return `@${withoutProvider.replace(/^user:/i, "")}`;
  }
  return withoutProvider;
}

function detectTargetKind(
  channel: ChannelId,
  raw: string,
  preferred?: TargetResolveKind,
): TargetResolveKind {
  if (preferred) {
    return preferred;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "group";
  }
  const inferredChatType = getChannelPlugin(channel)?.messaging?.inferTargetChatType?.({ to: raw });
  if (inferredChatType === "direct") {
    return "user";
  }
  if (inferredChatType === "channel") {
    return "channel";
  }
  if (inferredChatType === "group") {
    return "group";
  }

  if (trimmed.startsWith("@") || /^<@!?/.test(trimmed) || /^user:/i.test(trimmed)) {
    return "user";
  }
  if (trimmed.startsWith("#") || /^channel:/i.test(trimmed)) {
    return "group";
  }

  return "group";
}

function normalizeDirectoryEntryId(channel: ChannelId, entry: ChannelDirectoryEntry): string {
  const normalized = normalizeTargetForProvider(channel, entry.id);
  return normalized ?? entry.id.trim();
}

function matchesDirectoryEntry(params: {
  channel: ChannelId;
  entry: ChannelDirectoryEntry;
  query: string;
}): boolean {
  const query = normalizeQuery(params.query);
  if (!query) {
    return false;
  }
  const id = stripTargetPrefixes(normalizeDirectoryEntryId(params.channel, params.entry));
  const name = params.entry.name ? stripTargetPrefixes(params.entry.name) : "";
  const handle = params.entry.handle ? stripTargetPrefixes(params.entry.handle) : "";
  const candidates = [id, name, handle].map((value) => normalizeQuery(value)).filter(Boolean);
  return candidates.some((value) => value === query || value.includes(query));
}

function resolveMatch(params: {
  channel: ChannelId;
  entries: ChannelDirectoryEntry[];
  query: string;
}) {
  const matches = params.entries.filter((entry) =>
    matchesDirectoryEntry({ channel: params.channel, entry, query: params.query }),
  );
  if (matches.length === 0) {
    return { kind: "none" as const };
  }
  if (matches.length === 1) {
    return { entry: matches[0], kind: "single" as const };
  }
  return { entries: matches, kind: "ambiguous" as const };
}

async function listDirectoryEntries(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  runtime?: RuntimeEnv;
  query?: string;
  source: "cache" | "live";
}): Promise<ChannelDirectoryEntry[]> {
  const plugin = getChannelPlugin(params.channel);
  const directory = plugin?.directory;
  if (!directory) {
    return [];
  }
  const runtime = params.runtime ?? defaultRuntime;
  const useLive = params.source === "live";
  const fn =
    params.kind === "user"
      ? (useLive
        ? (directory.listPeersLive ?? directory.listPeers)
        : directory.listPeers)
      : (useLive
        ? (directory.listGroupsLive ?? directory.listGroups)
        : directory.listGroups);
  if (!fn) {
    return [];
  }
  return await fn({
    accountId: params.accountId ?? undefined,
    cfg: params.cfg,
    limit: undefined,
    query: params.query ?? undefined,
    runtime,
  });
}

async function getDirectoryEntries(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  query?: string;
  runtime?: RuntimeEnv;
  preferLiveOnMiss?: boolean;
}): Promise<ChannelDirectoryEntry[]> {
  const signature = buildTargetResolverSignature(params.channel);
  const listParams = {
    accountId: params.accountId,
    cfg: params.cfg,
    channel: params.channel,
    kind: params.kind,
    query: params.query,
    runtime: params.runtime,
  };
  const cacheKey = buildDirectoryCacheKey({
    accountId: params.accountId,
    channel: params.channel,
    kind: params.kind,
    signature,
    source: "cache",
  });
  const cached = directoryCache.get(cacheKey, params.cfg);
  if (cached) {
    return cached;
  }
  const entries = await listDirectoryEntries({
    ...listParams,
    source: "cache",
  });
  if (entries.length > 0 || !params.preferLiveOnMiss) {
    directoryCache.set(cacheKey, entries, params.cfg);
    return entries;
  }
  const liveKey = buildDirectoryCacheKey({
    accountId: params.accountId,
    channel: params.channel,
    kind: params.kind,
    signature,
    source: "live",
  });
  const liveEntries = await listDirectoryEntries({
    ...listParams,
    source: "live",
  });
  directoryCache.set(liveKey, liveEntries, params.cfg);
  directoryCache.set(cacheKey, liveEntries, params.cfg);
  return liveEntries;
}

function buildNormalizedResolveResult(params: {
  normalized: string;
  kind: TargetResolveKind;
}): ResolveMessagingTargetResult {
  return {
    ok: true,
    target: {
      display: stripTargetPrefixes(params.normalized),
      kind: params.kind,
      source: "normalized",
      to: params.normalized,
    },
  };
}

function pickAmbiguousMatch(
  entries: ChannelDirectoryEntry[],
  mode: ResolveAmbiguousMode,
): ChannelDirectoryEntry | null {
  if (entries.length === 0) {
    return null;
  }
  if (mode === "first") {
    return entries[0] ?? null;
  }
  const ranked = entries.map((entry) => ({
    entry,
    rank: typeof entry.rank === "number" ? entry.rank : 0,
  }));
  const bestRank = Math.max(...ranked.map((item) => item.rank));
  const best = ranked.find((item) => item.rank === bestRank)?.entry;
  return best ?? entries[0] ?? null;
}

export async function resolveMessagingTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKind;
  runtime?: RuntimeEnv;
  resolveAmbiguous?: ResolveAmbiguousMode;
}): Promise<ResolveMessagingTargetResult> {
  const raw = normalizeChannelTargetInput(params.input);
  if (!raw) {
    return { error: new Error("Target is required"), ok: false };
  }
  const plugin = getChannelPlugin(params.channel);
  const providerLabel = plugin?.meta?.label ?? params.channel;
  const hint = plugin?.messaging?.targetResolver?.hint;
  const kind = detectTargetKind(params.channel, raw, params.preferredKind);
  const normalizedInput = resolveNormalizedTargetInput(params.channel, raw);
  const normalized = normalizedInput?.normalized ?? raw;
  if (
    normalizedInput &&
    looksLikeTargetId({
      channel: params.channel,
      normalized,
      raw: normalizedInput.raw,
    })
  ) {
    const resolvedIdLikeTarget = await maybeResolveIdLikeTarget({
      accountId: params.accountId,
      cfg: params.cfg,
      channel: params.channel,
      input: raw,
      preferredKind: params.preferredKind,
    });
    if (resolvedIdLikeTarget) {
      return {
        ok: true,
        target: resolvedIdLikeTarget,
      };
    }
    return buildNormalizedResolveResult({
      kind,
      normalized,
    });
  }
  const query = stripTargetPrefixes(raw);
  const entries = await getDirectoryEntries({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: params.channel,
    kind: kind === "user" ? "user" : "group",
    preferLiveOnMiss: true,
    query,
    runtime: params.runtime,
  });
  const match = resolveMatch({ channel: params.channel, entries, query });
  if (match.kind === "single") {
    const {entry} = match;
    return {
      ok: true,
      target: {
        display: entry.name ?? entry.handle ?? stripTargetPrefixes(entry.id),
        kind,
        source: "directory",
        to: normalizeDirectoryEntryId(params.channel, entry),
      },
    };
  }
  if (match.kind === "ambiguous") {
    const mode = params.resolveAmbiguous ?? "error";
    if (mode !== "error") {
      const best = pickAmbiguousMatch(match.entries, mode);
      if (best) {
        return {
          ok: true,
          target: {
            display: best.name ?? best.handle ?? stripTargetPrefixes(best.id),
            kind,
            source: "directory",
            to: normalizeDirectoryEntryId(params.channel, best),
          },
        };
      }
    }
    return {
      candidates: match.entries,
      error: ambiguousTargetError(providerLabel, raw, hint),
      ok: false,
    };
  }
  const resolvedFallbackTarget = asResolvedMessagingTarget(
    await maybeResolvePluginMessagingTarget({
      accountId: params.accountId,
      cfg: params.cfg,
      channel: params.channel,
      input: raw,
      preferredKind: params.preferredKind,
    }),
  );
  if (resolvedFallbackTarget) {
    return {
      ok: true,
      target: resolvedFallbackTarget,
    };
  }

  return {
    error: unknownTargetError(providerLabel, raw, hint),
    ok: false,
  };
}

export async function lookupDirectoryDisplay(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  targetId: string;
  accountId?: string | null;
  runtime?: RuntimeEnv;
}): Promise<string | undefined> {
  const normalized = normalizeTargetForProvider(params.channel, params.targetId) ?? params.targetId;

  // Targets can resolve to either peers (DMs) or groups. Try both.
  const [groups, users] = await Promise.all([
    getDirectoryEntries({
      accountId: params.accountId,
      cfg: params.cfg,
      channel: params.channel,
      kind: "group",
      preferLiveOnMiss: false,
      runtime: params.runtime,
    }),
    getDirectoryEntries({
      accountId: params.accountId,
      cfg: params.cfg,
      channel: params.channel,
      kind: "user",
      preferLiveOnMiss: false,
      runtime: params.runtime,
    }),
  ]);

  const findMatch = (candidates: ChannelDirectoryEntry[]) =>
    candidates.find(
      (candidate) => normalizeDirectoryEntryId(params.channel, candidate) === normalized,
    );

  const entry = findMatch(groups) ?? findMatch(users);
  return entry?.name ?? entry?.handle ?? undefined;
}
