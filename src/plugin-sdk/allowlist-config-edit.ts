import type { ConfigWriteTarget } from "../channels/plugins/config-writes.js";
import type { ChannelAllowlistAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

interface AllowlistConfigPaths {
  readPaths: string[][];
  writePath: string[];
  cleanupPaths?: string[][];
}

export interface AllowlistGroupOverride { label: string; entries: string[] }
export type AllowlistNameResolution = {
  input: string;
  resolved: boolean;
  name?: string | null;
}[];
type AllowlistNormalizer = (params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  values: (string | number)[];
}) => string[];
type AllowlistAccountResolver<ResolvedAccount> = (params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => ResolvedAccount;

const DM_ALLOWLIST_CONFIG_PATHS: AllowlistConfigPaths = {
  readPaths: [["allowFrom"]],
  writePath: ["allowFrom"],
};

const GROUP_ALLOWLIST_CONFIG_PATHS: AllowlistConfigPaths = {
  readPaths: [["groupAllowFrom"]],
  writePath: ["groupAllowFrom"],
};

const LEGACY_DM_ALLOWLIST_CONFIG_PATHS: AllowlistConfigPaths = {
  cleanupPaths: [["dm", "allowFrom"]],
  readPaths: [["allowFrom"], ["dm", "allowFrom"]],
  writePath: ["allowFrom"],
};

export function resolveDmGroupAllowlistConfigPaths(scope: "dm" | "group") {
  return scope === "dm" ? DM_ALLOWLIST_CONFIG_PATHS : GROUP_ALLOWLIST_CONFIG_PATHS;
}

export function resolveLegacyDmAllowlistConfigPaths(scope: "dm" | "group") {
  return scope === "dm" ? LEGACY_DM_ALLOWLIST_CONFIG_PATHS : null;
}

/** Coerce stored allowlist entries into presentable non-empty strings. */
export function readConfiguredAllowlistEntries(
  entries: (string | number)[] | null | undefined,
): string[] {
  return (entries ?? []).map(String).filter(Boolean);
}

/** Collect labeled allowlist overrides from a flat keyed record. */
export function collectAllowlistOverridesFromRecord<T>(params: {
  record: Record<string, T | undefined> | null | undefined;
  label: (key: string, value: T) => string;
  resolveEntries: (value: T) => (string | number)[] | null | undefined;
}): AllowlistGroupOverride[] {
  const overrides: AllowlistGroupOverride[] = [];
  for (const [key, value] of Object.entries(params.record ?? {})) {
    if (!value) {
      continue;
    }
    const entries = readConfiguredAllowlistEntries(params.resolveEntries(value));
    if (entries.length === 0) {
      continue;
    }
    overrides.push({ entries, label: params.label(key, value) });
  }
  return overrides;
}

/** Collect labeled allowlist overrides from an outer record with nested child records. */
export function collectNestedAllowlistOverridesFromRecord<Outer, Inner>(params: {
  record: Record<string, Outer | undefined> | null | undefined;
  outerLabel: (key: string, value: Outer) => string;
  resolveOuterEntries: (value: Outer) => (string | number)[] | null | undefined;
  resolveChildren: (value: Outer) => Record<string, Inner | undefined> | null | undefined;
  innerLabel: (outerKey: string, innerKey: string, inner: Inner) => string;
  resolveInnerEntries: (value: Inner) => (string | number)[] | null | undefined;
}): AllowlistGroupOverride[] {
  const overrides: AllowlistGroupOverride[] = [];
  for (const [outerKey, outerValue] of Object.entries(params.record ?? {})) {
    if (!outerValue) {
      continue;
    }
    const outerEntries = readConfiguredAllowlistEntries(params.resolveOuterEntries(outerValue));
    if (outerEntries.length > 0) {
      overrides.push({ entries: outerEntries, label: params.outerLabel(outerKey, outerValue) });
    }
    overrides.push(
      ...collectAllowlistOverridesFromRecord({
        label: (innerKey, innerValue) => params.innerLabel(outerKey, innerKey, innerValue),
        record: params.resolveChildren(outerValue),
        resolveEntries: params.resolveInnerEntries,
      }),
    );
  }
  return overrides;
}

/** Build an account-scoped flat override resolver from a keyed allowlist record. */
export function createFlatAllowlistOverrideResolver<ResolvedAccount, Entry>(params: {
  resolveRecord: (account: ResolvedAccount) => Record<string, Entry | undefined> | null | undefined;
  label: (key: string, value: Entry) => string;
  resolveEntries: (value: Entry) => (string | number)[] | null | undefined;
}): (account: ResolvedAccount) => AllowlistGroupOverride[] {
  return (account) =>
    collectAllowlistOverridesFromRecord({
      label: params.label,
      record: params.resolveRecord(account),
      resolveEntries: params.resolveEntries,
    });
}

/** Build an account-scoped nested override resolver from hierarchical allowlist records. */
export function createNestedAllowlistOverrideResolver<ResolvedAccount, Outer, Inner>(params: {
  resolveRecord: (account: ResolvedAccount) => Record<string, Outer | undefined> | null | undefined;
  outerLabel: (key: string, value: Outer) => string;
  resolveOuterEntries: (value: Outer) => (string | number)[] | null | undefined;
  resolveChildren: (value: Outer) => Record<string, Inner | undefined> | null | undefined;
  innerLabel: (outerKey: string, innerKey: string, inner: Inner) => string;
  resolveInnerEntries: (value: Inner) => (string | number)[] | null | undefined;
}): (account: ResolvedAccount) => AllowlistGroupOverride[] {
  return (account) =>
    collectNestedAllowlistOverridesFromRecord({
      innerLabel: params.innerLabel,
      outerLabel: params.outerLabel,
      record: params.resolveRecord(account),
      resolveChildren: params.resolveChildren,
      resolveInnerEntries: params.resolveInnerEntries,
      resolveOuterEntries: params.resolveOuterEntries,
    });
}

/** Build the common account-scoped token-gated allowlist name resolver. */
export function createAccountScopedAllowlistNameResolver<ResolvedAccount>(params: {
  resolveAccount: (params: { cfg: OpenClawConfig; accountId?: string | null }) => ResolvedAccount;
  resolveToken: (account: ResolvedAccount) => string | null | undefined;
  resolveNames: (params: { token: string; entries: string[] }) => Promise<AllowlistNameResolution>;
}): NonNullable<ChannelAllowlistAdapter["resolveNames"]> {
  return async ({ cfg, accountId, entries }) => {
    const account = params.resolveAccount({ accountId, cfg });
    const token = params.resolveToken(account)?.trim();
    if (!token) {
      return [];
    }
    return await params.resolveNames({ entries, token });
  };
}

function resolveAccountScopedWriteTarget(
  parsed: Record<string, unknown>,
  channelId: ChannelId,
  accountId?: string | null,
) {
  const channels = (parsed.channels ??= {}) as Record<string, unknown>;
  const channel = (channels[channelId] ??= {}) as Record<string, unknown>;
  const normalizedAccountId = normalizeAccountId(accountId);
  if (isBlockedObjectKey(normalizedAccountId)) {
    return {
      pathPrefix: `channels.${channelId}`,
      target: channel,
      writeTarget: { kind: "channel", scope: { channelId } } as const satisfies ConfigWriteTarget,
    };
  }
  const hasAccounts = Boolean(channel.accounts && typeof channel.accounts === "object");
  const useAccount = normalizedAccountId !== DEFAULT_ACCOUNT_ID || hasAccounts;
  if (!useAccount) {
    return {
      pathPrefix: `channels.${channelId}`,
      target: channel,
      writeTarget: { kind: "channel", scope: { channelId } } as const satisfies ConfigWriteTarget,
    };
  }
  const accounts = (channel.accounts ??= {}) as Record<string, unknown>;
  const existingAccount = Object.hasOwn(accounts, normalizedAccountId)
    ? accounts[normalizedAccountId]
    : undefined;
  if (!existingAccount || typeof existingAccount !== "object") {
    accounts[normalizedAccountId] = {};
  }
  const account = accounts[normalizedAccountId] as Record<string, unknown>;
  return {
    pathPrefix: `channels.${channelId}.accounts.${normalizedAccountId}`,
    target: account,
    writeTarget: {
      kind: "account",
      scope: { accountId: normalizedAccountId, channelId },
    } as const satisfies ConfigWriteTarget,
  };
}

function getNestedValue(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function ensureNestedObject(
  root: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  let current = root;
  for (const key of path) {
    const existing = current[key];
    if (!existing || typeof existing !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

function setNestedValue(root: Record<string, unknown>, path: string[], value: unknown) {
  if (path.length === 0) {
    return;
  }
  if (path.length === 1) {
    root[path[0]] = value;
    return;
  }
  const parent = ensureNestedObject(root, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
}

function deleteNestedValue(root: Record<string, unknown>, path: string[]) {
  if (path.length === 0) {
    return;
  }
  if (path.length === 1) {
    delete root[path[0]];
    return;
  }
  const parent = getNestedValue(root, path.slice(0, -1));
  if (!parent || typeof parent !== "object") {
    return;
  }
  delete (parent as Record<string, unknown>)[path[path.length - 1]];
}

function applyAccountScopedAllowlistConfigEdit(params: {
  parsedConfig: Record<string, unknown>;
  channelId: ChannelId;
  accountId?: string | null;
  action: "add" | "remove";
  entry: string;
  normalize: (values: (string | number)[]) => string[];
  paths: AllowlistConfigPaths;
}): NonNullable<Awaited<ReturnType<NonNullable<ChannelAllowlistAdapter["applyConfigEdit"]>>>> {
  const resolvedTarget = resolveAccountScopedWriteTarget(
    params.parsedConfig,
    params.channelId,
    params.accountId,
  );
  const existing: string[] = [];
  for (const path of params.paths.readPaths) {
    const existingRaw = getNestedValue(resolvedTarget.target, path);
    if (!Array.isArray(existingRaw)) {
      continue;
    }
    for (const entry of existingRaw) {
      const value = String(entry).trim();
      if (!value || existing.includes(value)) {
        continue;
      }
      existing.push(value);
    }
  }

  const normalizedEntry = params.normalize([params.entry]);
  if (normalizedEntry.length === 0) {
    return { kind: "invalid-entry" };
  }

  const existingNormalized = params.normalize(existing);
  const shouldMatch = (value: string) => normalizedEntry.includes(value);

  let changed = false;
  let next = existing;
  const configHasEntry = existingNormalized.some((value) => shouldMatch(value));
  if (params.action === "add") {
    if (!configHasEntry) {
      next = [...existing, params.entry.trim()];
      changed = true;
    }
  } else {
    const keep: string[] = [];
    for (const entry of existing) {
      const normalized = params.normalize([entry]);
      if (normalized.some((value) => shouldMatch(value))) {
        changed = true;
        continue;
      }
      keep.push(entry);
    }
    next = keep;
  }

  if (changed) {
    if (next.length === 0) {
      deleteNestedValue(resolvedTarget.target, params.paths.writePath);
    } else {
      setNestedValue(resolvedTarget.target, params.paths.writePath, next);
    }
    for (const path of params.paths.cleanupPaths ?? []) {
      deleteNestedValue(resolvedTarget.target, path);
    }
  }

  return {
    changed,
    kind: "ok",
    pathLabel: `${resolvedTarget.pathPrefix}.${params.paths.writePath.join(".")}`,
    writeTarget: resolvedTarget.writeTarget,
  };
}

/** Build the default account-scoped allowlist editor used by channel plugins with config-backed lists. */
export function buildAccountScopedAllowlistConfigEditor(params: {
  channelId: ChannelId;
  normalize: AllowlistNormalizer;
  resolvePaths: (scope: "dm" | "group") => AllowlistConfigPaths | null;
}): NonNullable<ChannelAllowlistAdapter["applyConfigEdit"]> {
  return ({ cfg, parsedConfig, accountId, scope, action, entry }) => {
    const paths = params.resolvePaths(scope);
    if (!paths) {
      return null;
    }
    return applyAccountScopedAllowlistConfigEdit({
      accountId,
      action,
      channelId: params.channelId,
      entry,
      normalize: (values) => params.normalize({ accountId, cfg, values }),
      parsedConfig,
      paths,
    });
  };
}

function buildAccountAllowlistAdapter<ResolvedAccount>(params: {
  channelId: ChannelId;
  resolveAccount: AllowlistAccountResolver<ResolvedAccount>;
  normalize: AllowlistNormalizer;
  supportsScope: NonNullable<ChannelAllowlistAdapter["supportsScope"]>;
  resolvePaths: (scope: "dm" | "group") => AllowlistConfigPaths | null;
  readConfig: (
    account: ResolvedAccount,
  ) => Awaited<ReturnType<NonNullable<ChannelAllowlistAdapter["readConfig"]>>>;
}): Pick<ChannelAllowlistAdapter, "supportsScope" | "readConfig" | "applyConfigEdit"> {
  return {
    applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
      channelId: params.channelId,
      normalize: params.normalize,
      resolvePaths: params.resolvePaths,
    }),
    readConfig: ({ cfg, accountId }) =>
      params.readConfig(params.resolveAccount({ accountId, cfg })),
    supportsScope: params.supportsScope,
  };
}

/** Build the common DM/group allowlist adapter used by channels that store both lists in config. */
export function buildDmGroupAccountAllowlistAdapter<ResolvedAccount>(params: {
  channelId: ChannelId;
  resolveAccount: AllowlistAccountResolver<ResolvedAccount>;
  normalize: AllowlistNormalizer;
  resolveDmAllowFrom: (account: ResolvedAccount) => (string | number)[] | null | undefined;
  resolveGroupAllowFrom: (account: ResolvedAccount) => (string | number)[] | null | undefined;
  resolveDmPolicy?: (account: ResolvedAccount) => string | null | undefined;
  resolveGroupPolicy?: (account: ResolvedAccount) => string | null | undefined;
  resolveGroupOverrides?: (account: ResolvedAccount) => AllowlistGroupOverride[] | undefined;
}): Pick<ChannelAllowlistAdapter, "supportsScope" | "readConfig" | "applyConfigEdit"> {
  return buildAccountAllowlistAdapter({
    channelId: params.channelId,
    normalize: params.normalize,
    readConfig: (account) => ({
      dmAllowFrom: readConfiguredAllowlistEntries(params.resolveDmAllowFrom(account)),
      dmPolicy: params.resolveDmPolicy?.(account) ?? undefined,
      groupAllowFrom: readConfiguredAllowlistEntries(params.resolveGroupAllowFrom(account)),
      groupOverrides: params.resolveGroupOverrides?.(account),
      groupPolicy: params.resolveGroupPolicy?.(account) ?? undefined,
    }),
    resolveAccount: params.resolveAccount,
    resolvePaths: resolveDmGroupAllowlistConfigPaths,
    supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
  });
}

/** Build the common DM-only allowlist adapter for channels with legacy dm.allowFrom fallback paths. */
export function buildLegacyDmAccountAllowlistAdapter<ResolvedAccount>(params: {
  channelId: ChannelId;
  resolveAccount: AllowlistAccountResolver<ResolvedAccount>;
  normalize: AllowlistNormalizer;
  resolveDmAllowFrom: (account: ResolvedAccount) => (string | number)[] | null | undefined;
  resolveGroupPolicy?: (account: ResolvedAccount) => string | null | undefined;
  resolveGroupOverrides?: (account: ResolvedAccount) => AllowlistGroupOverride[] | undefined;
}): Pick<ChannelAllowlistAdapter, "supportsScope" | "readConfig" | "applyConfigEdit"> {
  return buildAccountAllowlistAdapter({
    channelId: params.channelId,
    normalize: params.normalize,
    readConfig: (account) => ({
      dmAllowFrom: readConfiguredAllowlistEntries(params.resolveDmAllowFrom(account)),
      groupOverrides: params.resolveGroupOverrides?.(account),
      groupPolicy: params.resolveGroupPolicy?.(account) ?? undefined,
    }),
    resolveAccount: params.resolveAccount,
    resolvePaths: resolveLegacyDmAllowlistConfigPaths,
    supportsScope: ({ scope }) => scope === "dm",
  });
}
