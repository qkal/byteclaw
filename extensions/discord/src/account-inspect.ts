import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  mergeDiscordAccountConfig,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccountConfig,
} from "./accounts.js";
import type { DiscordAccountConfig, OpenClawConfig } from "./runtime-api.js";

export type DiscordCredentialStatus = "available" | "configured_unavailable" | "missing";

export interface InspectedDiscordAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "config" | "none";
  tokenStatus: DiscordCredentialStatus;
  configured: boolean;
  config: DiscordAccountConfig;
}

function inspectDiscordTokenValue(value: unknown): {
  token: string;
  tokenSource: "config";
  tokenStatus: Exclude<DiscordCredentialStatus, "missing">;
} | null {
  const normalized = normalizeSecretInputString(value);
  if (normalized) {
    return {
      token: normalized.replace(/^Bot\s+/i, ""),
      tokenSource: "config",
      tokenStatus: "available",
    };
  }
  if (hasConfiguredSecretInput(value)) {
    return {
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    };
  }
  return null;
}

export function inspectDiscordAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envToken?: string | null;
}): InspectedDiscordAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const enabled = params.cfg.channels?.discord?.enabled !== false && merged.enabled !== false;
  const accountConfig = resolveDiscordAccountConfig(params.cfg, accountId);
  const hasAccountToken = Boolean(
    accountConfig && Object.hasOwn(accountConfig as Record<string, unknown>, "token"),
  );
  const accountToken = inspectDiscordTokenValue(accountConfig?.token);
  if (accountToken) {
    return {
      accountId,
      config: merged,
      configured: true,
      enabled,
      name: normalizeOptionalString(merged.name),
      token: accountToken.token,
      tokenSource: accountToken.tokenSource,
      tokenStatus: accountToken.tokenStatus,
    };
  }
  if (hasAccountToken) {
    return {
      accountId,
      config: merged,
      configured: false,
      enabled,
      name: normalizeOptionalString(merged.name),
      token: "",
      tokenSource: "none",
      tokenStatus: "missing",
    };
  }

  const channelToken = inspectDiscordTokenValue(params.cfg.channels?.discord?.token);
  if (channelToken) {
    return {
      accountId,
      config: merged,
      configured: true,
      enabled,
      name: normalizeOptionalString(merged.name),
      token: channelToken.token,
      tokenSource: channelToken.tokenSource,
      tokenStatus: channelToken.tokenStatus,
    };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? normalizeSecretInputString(params.envToken ?? process.env.DISCORD_BOT_TOKEN)
    : undefined;
  if (envToken) {
    return {
      accountId,
      config: merged,
      configured: true,
      enabled,
      name: normalizeOptionalString(merged.name),
      token: envToken.replace(/^Bot\s+/i, ""),
      tokenSource: "env",
      tokenStatus: "available",
    };
  }

  return {
    accountId,
    config: merged,
    configured: false,
    enabled,
    name: normalizeOptionalString(merged.name),
    token: "",
    tokenSource: "none",
    tokenStatus: "missing",
  };
}
