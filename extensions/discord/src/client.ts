import type { RequestClient } from "@buape/carbon";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RetryConfig, RetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  type ResolvedDiscordAccount,
  mergeDiscordAccountConfig,
  resolveDiscordAccount,
} from "./accounts.js";
import { resolveDiscordProxyFetchForAccount } from "./proxy-fetch.js";
import { createDiscordRequestClient } from "./proxy-request-client.js";
import { createDiscordRetryRunner } from "./retry.js";
import type { DiscordRuntimeAccountContext } from "./send.types.js";
import { normalizeDiscordToken } from "./token.js";

export interface DiscordClientOpts {
  cfg?: ReturnType<typeof loadConfig>;
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
}

export function createDiscordRuntimeAccountContext(params: {
  cfg: ReturnType<typeof loadConfig>;
  accountId: string;
}): DiscordRuntimeAccountContext {
  return {
    accountId: normalizeAccountId(params.accountId),
    cfg: params.cfg,
  };
}

export function resolveDiscordClientAccountContext(
  opts: Pick<DiscordClientOpts, "cfg" | "accountId">,
  cfg?: ReturnType<typeof loadConfig>,
  runtime?: Pick<RuntimeEnv, "error">,
) {
  const resolvedCfg = opts.cfg ?? cfg ?? loadConfig();
  const account = resolveAccountWithoutToken({
    accountId: opts.accountId,
    cfg: resolvedCfg,
  });
  return {
    account,
    cfg: resolvedCfg,
    proxyFetch: resolveDiscordProxyFetchForAccount(account, resolvedCfg, runtime),
  };
}

function resolveToken(params: { accountId: string; fallbackToken?: string }) {
  const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
  if (!fallback) {
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

export function resolveDiscordProxyFetch(
  opts: Pick<DiscordClientOpts, "cfg" | "accountId">,
  cfg?: ReturnType<typeof loadConfig>,
  runtime?: Pick<RuntimeEnv, "error">,
): typeof fetch | undefined {
  return resolveDiscordClientAccountContext(opts, cfg, runtime).proxyFetch;
}

function resolveRest(
  token: string,
  account: ResolvedDiscordAccount,
  cfg: ReturnType<typeof loadConfig>,
  rest?: RequestClient,
  proxyFetch?: typeof fetch,
) {
  if (rest) {
    return rest;
  }
  const resolvedProxyFetch = proxyFetch ?? resolveDiscordProxyFetchForAccount(account, cfg);
  return createDiscordRequestClient(
    token,
    resolvedProxyFetch ? { fetch: resolvedProxyFetch } : undefined,
  );
}

function resolveAccountWithoutToken(params: {
  cfg: ReturnType<typeof loadConfig>;
  accountId?: string;
}): ResolvedDiscordAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  return {
    accountId,
    config: merged,
    enabled: baseEnabled && accountEnabled,
    name: normalizeOptionalString(merged.name),
    token: "",
    tokenSource: "none",
  };
}

export function createDiscordRestClient(
  opts: DiscordClientOpts,
  cfg?: ReturnType<typeof loadConfig>,
) {
  const explicitToken = normalizeDiscordToken(opts.token, "channels.discord.token");
  const proxyContext = resolveDiscordClientAccountContext(opts, cfg);
  const resolvedCfg = proxyContext.cfg;
  const account = explicitToken
    ? proxyContext.account
    : resolveDiscordAccount({ accountId: opts.accountId, cfg: resolvedCfg });
  const token =
    explicitToken ??
    resolveToken({
      accountId: account.accountId,
      fallbackToken: account.token,
    });
  const rest = resolveRest(token, account, resolvedCfg, opts.rest, proxyContext.proxyFetch);
  return { account, rest, token };
}

export function createDiscordClient(
  opts: DiscordClientOpts,
  cfg?: ReturnType<typeof loadConfig>,
): { token: string; rest: RequestClient; request: RetryRunner } {
  const { token, rest, account } = createDiscordRestClient(opts, opts.cfg ?? cfg);
  const request = createDiscordRetryRunner({
    configRetry: account.config.retry,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  return { request, rest, token };
}

export function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordRestClient(opts, opts.cfg).rest;
}
