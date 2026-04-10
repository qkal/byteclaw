import {
  listCombinedAccountIds,
  listConfiguredAccountIds,
  resolveListedDefaultAccountId,
  resolveNormalizedAccountEntry,
} from "openclaw/plugin-sdk/account-core";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  type MatrixResolvedStringField,
  resolveMatrixAccountStringValues,
} from "./auth-precedence.js";
import { getMatrixScopedEnvVarNames, listMatrixEnvAccountIds } from "./env-vars.js";
import { isRecord } from "./record-shared.js";

type MatrixTopologyStringSources = Partial<Record<MatrixResolvedStringField, string>>;

function readConfiguredMatrixString(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

function readConfiguredMatrixSecretSource(value: unknown): string {
  return hasConfiguredSecretInput(value) ? "configured" : "";
}

function resolveMatrixChannelStringSources(
  entry: Record<string, unknown> | null,
): MatrixTopologyStringSources {
  if (!entry) {
    return {};
  }
  return {
    accessToken: readConfiguredMatrixSecretSource(entry.accessToken),
    deviceId: readConfiguredMatrixString(entry.deviceId),
    deviceName: readConfiguredMatrixString(entry.deviceName),
    homeserver: readConfiguredMatrixString(entry.homeserver),
    password: readConfiguredMatrixSecretSource(entry.password),
    userId: readConfiguredMatrixString(entry.userId),
  };
}

function readEnvMatrixString(env: NodeJS.ProcessEnv, key: string): string {
  return normalizeOptionalString(env[key]) ?? "";
}

function resolveScopedMatrixEnvStringSources(
  accountId: string,
  env: NodeJS.ProcessEnv,
): MatrixTopologyStringSources {
  const keys = getMatrixScopedEnvVarNames(accountId);
  return {
    accessToken: readEnvMatrixString(env, keys.accessToken),
    deviceId: readEnvMatrixString(env, keys.deviceId),
    deviceName: readEnvMatrixString(env, keys.deviceName),
    homeserver: readEnvMatrixString(env, keys.homeserver),
    password: readEnvMatrixString(env, keys.password),
    userId: readEnvMatrixString(env, keys.userId),
  };
}

function resolveGlobalMatrixEnvStringSources(env: NodeJS.ProcessEnv): MatrixTopologyStringSources {
  return {
    accessToken: readEnvMatrixString(env, "MATRIX_ACCESS_TOKEN"),
    deviceId: readEnvMatrixString(env, "MATRIX_DEVICE_ID"),
    deviceName: readEnvMatrixString(env, "MATRIX_DEVICE_NAME"),
    homeserver: readEnvMatrixString(env, "MATRIX_HOMESERVER"),
    password: readEnvMatrixString(env, "MATRIX_PASSWORD"),
    userId: readEnvMatrixString(env, "MATRIX_USER_ID"),
  };
}

function hasUsableResolvedMatrixAuth(values: {
  homeserver: string;
  userId: string;
  accessToken: string;
}): boolean {
  // Account discovery must keep homeserver+userId shapes because auth can still
  // Resolve through cached Matrix credentials even when no fresh token/password
  // Is present in config or env.
  return Boolean(values.homeserver && (values.accessToken || values.userId));
}

function hasFreshResolvedMatrixAuth(values: {
  homeserver: string;
  userId: string;
  accessToken: string;
  password: string;
}): boolean {
  return Boolean(values.homeserver && (values.accessToken || (values.userId && values.password)));
}

function resolveEffectiveMatrixAccountSources(params: {
  channel: Record<string, unknown> | null;
  accountId: string;
  env: NodeJS.ProcessEnv;
}): ReturnType<typeof resolveMatrixAccountStringValues> {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  return resolveMatrixAccountStringValues({
    accountId: normalizedAccountId,
    channel: resolveMatrixChannelStringSources(params.channel),
    globalEnv: resolveGlobalMatrixEnvStringSources(params.env),
    scopedEnv: resolveScopedMatrixEnvStringSources(normalizedAccountId, params.env),
  });
}

function hasUsableEffectiveMatrixAccountSource(params: {
  channel: Record<string, unknown> | null;
  accountId: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  return hasUsableResolvedMatrixAuth(resolveEffectiveMatrixAccountSources(params));
}

function hasFreshEffectiveMatrixAccountSource(params: {
  channel: Record<string, unknown> | null;
  accountId: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  return hasFreshResolvedMatrixAuth(resolveEffectiveMatrixAccountSources(params));
}

function hasConfiguredDefaultMatrixAccountSource(params: {
  channel: Record<string, unknown> | null;
  env: NodeJS.ProcessEnv;
}): boolean {
  return hasFreshEffectiveMatrixAccountSource({
    accountId: DEFAULT_ACCOUNT_ID,
    channel: params.channel,
    env: params.env,
  });
}

export function resolveMatrixChannelConfig(cfg: OpenClawConfig): Record<string, unknown> | null {
  return isRecord(cfg.channels?.matrix) ? cfg.channels.matrix : null;
}

export function findMatrixAccountEntry(
  cfg: OpenClawConfig,
  accountId: string,
): Record<string, unknown> | null {
  const channel = resolveMatrixChannelConfig(cfg);
  if (!channel) {
    return null;
  }

  const accounts = isRecord(channel.accounts) ? channel.accounts : null;
  if (!accounts) {
    return null;
  }
  const entry = resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId);
  return isRecord(entry) ? entry : null;
}

export function resolveConfiguredMatrixAccountIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const channel = resolveMatrixChannelConfig(cfg);
  const configuredAccountIds = listConfiguredAccountIds({
    accounts: channel && isRecord(channel.accounts) ? channel.accounts : undefined,
    normalizeAccountId,
  });
  if (hasConfiguredDefaultMatrixAccountSource({ channel, env })) {
    configuredAccountIds.push(DEFAULT_ACCOUNT_ID);
  }
  const readyEnvAccountIds = listMatrixEnvAccountIds(env).filter((accountId) =>
    normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID
      ? hasConfiguredDefaultMatrixAccountSource({ channel, env })
      : hasUsableEffectiveMatrixAccountSource({ accountId, channel, env }),
  );
  return listCombinedAccountIds({
    additionalAccountIds: readyEnvAccountIds,
    configuredAccountIds,
    fallbackAccountIdWhenEmpty: channel ? DEFAULT_ACCOUNT_ID : undefined,
  });
}

export function resolveMatrixDefaultOrOnlyAccountId(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const channel = resolveMatrixChannelConfig(cfg);
  if (!channel) {
    return DEFAULT_ACCOUNT_ID;
  }

  const configuredDefault = normalizeOptionalAccountId(
    typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
  );
  const configuredAccountIds = resolveConfiguredMatrixAccountIds(cfg, env);
  return resolveListedDefaultAccountId({
    accountIds: configuredAccountIds,
    ambiguousFallbackAccountId: DEFAULT_ACCOUNT_ID,
    configuredDefaultAccountId: configuredDefault,
  });
}

export function requiresExplicitMatrixDefaultAccount(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const channel = resolveMatrixChannelConfig(cfg);
  if (!channel) {
    return false;
  }
  const configuredAccountIds = resolveConfiguredMatrixAccountIds(cfg, env);
  if (configuredAccountIds.length <= 1) {
    return false;
  }
  const configuredDefault = normalizeOptionalAccountId(
    typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
  );
  return !(configuredDefault && configuredAccountIds.includes(configuredDefault));
}
