import util from "node:util";
import {
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  createAccountActionGate,
  listCombinedAccountIds,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveAccountEntry,
  resolveAccountWithDefaultFallback,
  resolveListedDefaultAccountId,
} from "openclaw/plugin-sdk/account-core";
import type {
  TelegramAccountConfig,
  TelegramActionConfig,
} from "openclaw/plugin-sdk/config-runtime";
import {
  listBoundAccountIds,
  resolveDefaultAgentBoundAccountId,
} from "openclaw/plugin-sdk/routing";
import { formatSetExplicitDefaultInstruction } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger, isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { TelegramTransport } from "./fetch.js";
import { resolveTelegramToken } from "./token.js";

let log: ReturnType<typeof createSubsystemLogger> | null = null;

function getLog() {
  if (!log) {
    log = createSubsystemLogger("telegram/accounts");
  }
  return log;
}

function formatDebugArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  return util.inspect(value, { breakLength: Infinity, colors: false, compact: true, depth: null });
}

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS)) {
    const parts = args.map((arg) => formatDebugArg(arg));
    getLog().warn(parts.join(" ").trim());
  }
};

export interface ResolvedTelegramAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: TelegramAccountConfig;
}

export interface TelegramMediaRuntimeOptions {
  token: string;
  transport?: TelegramTransport;
  apiRoot?: string;
  trustedLocalFileRoots?: readonly string[];
  dangerouslyAllowPrivateNetwork?: boolean;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  for (const key of Object.keys(cfg.channels?.telegram?.accounts ?? {})) {
    if (key) {
      ids.add(normalizeAccountId(key));
    }
  }
  return [...ids];
}

export function listTelegramAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listCombinedAccountIds({
    additionalAccountIds: listBoundAccountIds(cfg, "telegram"),
    configuredAccountIds: listConfiguredAccountIds(cfg),
    fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID,
  });
  debugAccounts("listTelegramAccountIds", ids);
  return ids;
}

let emittedMissingDefaultWarn = false;

/** @internal Reset the once-per-process warning flag. Exported for tests only. */
export function resetMissingDefaultWarnFlag(): void {
  emittedMissingDefaultWarn = false;
}

export function resolveDefaultTelegramAccountId(cfg: OpenClawConfig): string {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "telegram");
  if (boundDefault) {
    return boundDefault;
  }
  const ids = listTelegramAccountIds(cfg);
  const resolved = resolveListedDefaultAccountId({
    accountIds: ids,
    configuredDefaultAccountId: normalizeOptionalAccountId(cfg.channels?.telegram?.defaultAccount),
  });
  if (resolved !== ids[0] || ids.includes(DEFAULT_ACCOUNT_ID) || ids.length <= 1) {
    return resolved;
  }
  if (ids.length > 1 && !emittedMissingDefaultWarn) {
    emittedMissingDefaultWarn = true;
    getLog().warn(
      `channels.telegram: accounts.default is missing; falling back to "${ids[0]}". ` +
        `${formatSetExplicitDefaultInstruction("telegram")} to avoid routing surprises in multi-account setups.`,
    );
  }
  return resolved;
}

export function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig | undefined {
  const normalized = normalizeAccountId(accountId);
  return resolveAccountEntry(cfg.channels?.telegram?.accounts, normalized);
}

export function mergeTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    groups: channelGroups,
    ...base
  } = (cfg.channels?.telegram ?? {}) as TelegramAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveTelegramAccountConfig(cfg, accountId) ?? {};

  // In multi-account setups, channel-level `groups` must NOT be inherited by
  // Accounts that don't have their own `groups` config.  A bot that is not a
  // Member of a configured group will fail when handling group messages, and
  // This failure disrupts message delivery for *all* accounts.
  // Single-account setups keep backward compat: channel-level groups still
  // Applies when the account has no override.
  // See: https://github.com/openclaw/openclaw/issues/30673
  const configuredAccountIds = Object.keys(cfg.channels?.telegram?.accounts ?? {});
  const isMultiAccount = configuredAccountIds.length > 1;
  const groups = account.groups ?? (isMultiAccount ? undefined : channelGroups);

  return { ...base, ...account, groups };
}

export function createTelegramActionGate(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
  );
  return createAccountActionGate({
    accountActions: resolveTelegramAccountConfig(params.cfg, accountId)?.actions,
    baseActions: params.cfg.channels?.telegram?.actions,
  });
}

export function resolveTelegramMediaRuntimeOptions(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  token: string;
  transport?: TelegramTransport;
}): TelegramMediaRuntimeOptions {
  const normalizedAccountId = normalizeOptionalAccountId(params.accountId);
  const accountCfg = normalizedAccountId
    ? mergeTelegramAccountConfig(params.cfg, normalizedAccountId)
    : params.cfg.channels?.telegram;
  return {
    apiRoot: accountCfg?.apiRoot,
    dangerouslyAllowPrivateNetwork: accountCfg?.network?.dangerouslyAllowPrivateNetwork,
    token: params.token,
    transport: params.transport,
    trustedLocalFileRoots: accountCfg?.trustedLocalFileRoots,
  };
}

export interface TelegramPollActionGateState {
  sendMessageEnabled: boolean;
  pollEnabled: boolean;
  enabled: boolean;
}

export function resolveTelegramPollActionGateState(
  isActionEnabled: (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean,
): TelegramPollActionGateState {
  const sendMessageEnabled = isActionEnabled("sendMessage");
  const pollEnabled = isActionEnabled("poll");
  return {
    enabled: sendMessageEnabled && pollEnabled,
    pollEnabled,
    sendMessageEnabled,
  };
}

export function resolveTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelegramAccount {
  const baseEnabled = params.cfg.channels?.telegram?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeTelegramAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
    debugAccounts("resolve", {
      accountId,
      enabled,
      tokenSource: tokenResolution.source,
    });
    return {
      accountId,
      config: merged,
      enabled,
      name: normalizeOptionalString(merged.name),
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
    } satisfies ResolvedTelegramAccount;
  };

  // If accountId is omitted, prefer a configured account token over failing on
  // The implicit "default" account. This keeps env-based setups working while
  // Making config-only tokens work for things like heartbeats.
  return resolveAccountWithDefaultFallback({
    accountId: params.accountId,
    hasCredential: (account) => account.tokenSource !== "none",
    normalizeAccountId,
    resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg),
    resolvePrimary: resolve,
  });
}

export function listEnabledTelegramAccounts(cfg: OpenClawConfig): ResolvedTelegramAccount[] {
  return listTelegramAccountIds(cfg)
    .map((accountId) => resolveTelegramAccount({ accountId, cfg }))
    .filter((account) => account.enabled);
}
