import {
  type OpenClawConfig,
  createAccountListHelpers,
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SignalAccountConfig } from "./account-types.js";

export interface ResolvedSignalAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  configured: boolean;
  config: SignalAccountConfig;
}

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("signal");
export const listSignalAccountIds = listAccountIds;
export const resolveDefaultSignalAccountId = resolveDefaultAccountId;

function mergeSignalAccountConfig(cfg: OpenClawConfig, accountId: string): SignalAccountConfig {
  return resolveMergedAccountConfig<SignalAccountConfig>({
    accountId,
    accounts: cfg.channels?.signal?.accounts as
      | Record<string, Partial<SignalAccountConfig>>
      | undefined,
    channelConfig: cfg.channels?.signal as SignalAccountConfig | undefined,
  });
}

export function resolveSignalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSignalAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.signal?.enabled !== false;
  const merged = mergeSignalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const host = normalizeOptionalString(merged.httpHost) ?? "127.0.0.1";
  const port = merged.httpPort ?? 8080;
  const baseUrl = normalizeOptionalString(merged.httpUrl) ?? `http://${host}:${port}`;
  const configured = Boolean(
    normalizeOptionalString(merged.account) ||
    normalizeOptionalString(merged.httpUrl) ||
    normalizeOptionalString(merged.cliPath) ||
    normalizeOptionalString(merged.httpHost) ||
    typeof merged.httpPort === "number" ||
    typeof merged.autoStart === "boolean",
  );
  return {
    accountId,
    baseUrl,
    config: merged,
    configured,
    enabled,
    name: normalizeOptionalString(merged.name),
  };
}

export function listEnabledSignalAccounts(cfg: OpenClawConfig): ResolvedSignalAccount[] {
  return listSignalAccountIds(cfg)
    .map((accountId) => resolveSignalAccount({ accountId, cfg }))
    .filter((account) => account.enabled);
}
