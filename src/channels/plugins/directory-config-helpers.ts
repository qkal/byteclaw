import type { OpenClawConfig } from "../../config/types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { DirectoryConfigParams } from "./directory-types.js";
import type { ChannelDirectoryEntry } from "./types.js";

function resolveDirectoryQuery(query?: string | null): string {
  return normalizeLowercaseStringOrEmpty(query);
}

function resolveDirectoryLimit(limit?: number | null): number | undefined {
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

export function applyDirectoryQueryAndLimit(
  ids: string[],
  params: { query?: string | null; limit?: number | null },
): string[] {
  const q = resolveDirectoryQuery(params.query);
  const limit = resolveDirectoryLimit(params.limit);
  const filtered = ids.filter((id) => (q ? normalizeLowercaseStringOrEmpty(id).includes(q) : true));
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

export function toDirectoryEntries(kind: "user" | "group", ids: string[]): ChannelDirectoryEntry[] {
  return ids.map((id) => ({ id, kind }) as const);
}

function normalizeDirectoryIds(params: {
  rawIds: readonly string[];
  normalizeId?: (entry: string) => string | null | undefined;
}): string[] {
  return params.rawIds
    .map((entry) => normalizeOptionalString(entry) ?? "")
    .filter((entry) => Boolean(entry) && entry !== "*")
    .map((entry) => {
      const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
      return normalizeOptionalString(normalized) ?? "";
    })
    .filter(Boolean);
}

function collectDirectoryIdsFromEntries(params: {
  entries?: readonly unknown[];
  normalizeId?: (entry: string) => string | null | undefined;
}): string[] {
  return normalizeDirectoryIds({
    normalizeId: params.normalizeId,
    rawIds: (params.entries ?? []).map((entry) => String(entry)),
  });
}

function collectDirectoryIdsFromMapKeys(params: {
  groups?: Record<string, unknown>;
  normalizeId?: (entry: string) => string | null | undefined;
}): string[] {
  return normalizeDirectoryIds({
    normalizeId: params.normalizeId,
    rawIds: Object.keys(params.groups ?? {}),
  });
}

function dedupeDirectoryIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function collectNormalizedDirectoryIds(params: {
  sources: Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}): string[] {
  const ids = new Set<string>();
  for (const source of params.sources) {
    for (const value of source) {
      const raw = normalizeOptionalString(value) ?? "";
      if (!raw || raw === "*") {
        continue;
      }
      const normalized = params.normalizeId(raw);
      const trimmed = normalizeOptionalString(normalized) ?? "";
      if (trimmed) {
        ids.add(trimmed);
      }
    }
  }
  return [...ids];
}

export function listDirectoryEntriesFromSources(params: {
  kind: "user" | "group";
  sources: Iterable<unknown>[];
  query?: string | null;
  limit?: number | null;
  normalizeId: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = collectNormalizedDirectoryIds({
    normalizeId: params.normalizeId,
    sources: params.sources,
  });
  return toDirectoryEntries(params.kind, applyDirectoryQueryAndLimit(ids, params));
}

export function listInspectedDirectoryEntriesFromSources<InspectedAccount>(
  params: DirectoryConfigParams & {
    kind: "user" | "group";
    inspectAccount: (
      cfg: OpenClawConfig,
      accountId?: string | null,
    ) => InspectedAccount | null | undefined;
    resolveSources: (account: InspectedAccount) => Iterable<unknown>[];
    normalizeId: (entry: string) => string | null | undefined;
  },
): ChannelDirectoryEntry[] {
  const account = params.inspectAccount(params.cfg, params.accountId);
  if (!account) {
    return [];
  }
  return listDirectoryEntriesFromSources({
    kind: params.kind,
    limit: params.limit,
    normalizeId: params.normalizeId,
    query: params.query,
    sources: params.resolveSources(account),
  });
}

export function createInspectedDirectoryEntriesLister<InspectedAccount>(params: {
  kind: "user" | "group";
  inspectAccount: (
    cfg: OpenClawConfig,
    accountId?: string | null,
  ) => InspectedAccount | null | undefined;
  resolveSources: (account: InspectedAccount) => Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}) {
  return async (configParams: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]> =>
    listInspectedDirectoryEntriesFromSources({
      ...configParams,
      ...params,
    });
}

export function listResolvedDirectoryEntriesFromSources<ResolvedAccount>(
  params: DirectoryConfigParams & {
    kind: "user" | "group";
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    resolveSources: (account: ResolvedAccount) => Iterable<unknown>[];
    normalizeId: (entry: string) => string | null | undefined;
  },
): ChannelDirectoryEntry[] {
  const account = params.resolveAccount(params.cfg, params.accountId);
  return listDirectoryEntriesFromSources({
    kind: params.kind,
    limit: params.limit,
    normalizeId: params.normalizeId,
    query: params.query,
    sources: params.resolveSources(account),
  });
}

export function createResolvedDirectoryEntriesLister<ResolvedAccount>(params: {
  kind: "user" | "group";
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
  resolveSources: (account: ResolvedAccount) => Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}) {
  return async (configParams: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]> =>
    listResolvedDirectoryEntriesFromSources({
      ...configParams,
      ...params,
    });
}

export function listDirectoryUserEntriesFromAllowFrom(params: {
  allowFrom?: readonly unknown[];
  query?: string | null;
  limit?: number | null;
  normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = dedupeDirectoryIds(
    collectDirectoryIdsFromEntries({
      entries: params.allowFrom,
      normalizeId: params.normalizeId,
    }),
  );
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export function listDirectoryUserEntriesFromAllowFromAndMapKeys(params: {
  allowFrom?: readonly unknown[];
  map?: Record<string, unknown>;
  query?: string | null;
  limit?: number | null;
  normalizeAllowFromId?: (entry: string) => string | null | undefined;
  normalizeMapKeyId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = dedupeDirectoryIds([
    ...collectDirectoryIdsFromEntries({
      entries: params.allowFrom,
      normalizeId: params.normalizeAllowFromId,
    }),
    ...collectDirectoryIdsFromMapKeys({
      groups: params.map,
      normalizeId: params.normalizeMapKeyId,
    }),
  ]);
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export function listDirectoryGroupEntriesFromMapKeys(params: {
  groups?: Record<string, unknown>;
  query?: string | null;
  limit?: number | null;
  normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = dedupeDirectoryIds(
    collectDirectoryIdsFromMapKeys({
      groups: params.groups,
      normalizeId: params.normalizeId,
    }),
  );
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}

export function listDirectoryGroupEntriesFromMapKeysAndAllowFrom(params: {
  groups?: Record<string, unknown>;
  allowFrom?: readonly unknown[];
  query?: string | null;
  limit?: number | null;
  normalizeMapKeyId?: (entry: string) => string | null | undefined;
  normalizeAllowFromId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = dedupeDirectoryIds([
    ...collectDirectoryIdsFromMapKeys({
      groups: params.groups,
      normalizeId: params.normalizeMapKeyId,
    }),
    ...collectDirectoryIdsFromEntries({
      entries: params.allowFrom,
      normalizeId: params.normalizeAllowFromId,
    }),
  ]);
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}

export function listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedAccount>(
  params: DirectoryConfigParams & {
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    resolveAllowFrom: (account: ResolvedAccount) => readonly unknown[] | undefined;
    normalizeId?: (entry: string) => string | null | undefined;
  },
): ChannelDirectoryEntry[] {
  const account = params.resolveAccount(params.cfg, params.accountId);
  return listDirectoryUserEntriesFromAllowFrom({
    allowFrom: params.resolveAllowFrom(account),
    limit: params.limit,
    normalizeId: params.normalizeId,
    query: params.query,
  });
}

export function listResolvedDirectoryGroupEntriesFromMapKeys<ResolvedAccount>(
  params: DirectoryConfigParams & {
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    resolveGroups: (account: ResolvedAccount) => Record<string, unknown> | undefined;
    normalizeId?: (entry: string) => string | null | undefined;
  },
): ChannelDirectoryEntry[] {
  const account = params.resolveAccount(params.cfg, params.accountId);
  return listDirectoryGroupEntriesFromMapKeys({
    groups: params.resolveGroups(account),
    limit: params.limit,
    normalizeId: params.normalizeId,
    query: params.query,
  });
}
