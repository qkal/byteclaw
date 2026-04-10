import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  resolveConfiguredMatrixAccountIds,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../account-selection.js";
import { resolveMatrixAccountStringValues } from "../auth-precedence.js";
import type { CoreConfig, MatrixConfig } from "../types.js";
import {
  findMatrixAccountConfig,
  resolveMatrixAccountConfig,
  resolveMatrixBaseConfig,
} from "./account-config.js";
import { resolveGlobalMatrixEnvConfig, resolveScopedMatrixEnvConfig } from "./client/env-auth.js";
import { credentialsMatchConfig, loadMatrixCredentials } from "./credentials-read.js";

export interface ResolvedMatrixAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  homeserver?: string;
  userId?: string;
  config: MatrixConfig;
}

function clean(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

function resolveMatrixAccountAuthView(params: {
  cfg: CoreConfig;
  accountId: string;
  env: NodeJS.ProcessEnv;
}): {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
} {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const matrix = resolveMatrixBaseConfig(params.cfg);
  const account = findMatrixAccountConfig(params.cfg, normalizedAccountId) ?? {};
  const resolvedStrings = resolveMatrixAccountStringValues({
    account: {
      accessToken: typeof account.accessToken === "string" ? clean(account.accessToken) : "",
      deviceId: clean(account.deviceId),
      deviceName: clean(account.deviceName),
      homeserver: clean(account.homeserver),
      password: typeof account.password === "string" ? clean(account.password) : "",
      userId: clean(account.userId),
    },
    accountId: normalizedAccountId,
    channel: {
      accessToken: typeof matrix.accessToken === "string" ? clean(matrix.accessToken) : "",
      deviceId: clean(matrix.deviceId),
      deviceName: clean(matrix.deviceName),
      homeserver: clean(matrix.homeserver),
      password: typeof matrix.password === "string" ? clean(matrix.password) : "",
      userId: clean(matrix.userId),
    },
    globalEnv: resolveGlobalMatrixEnvConfig(params.env),
    scopedEnv: resolveScopedMatrixEnvConfig(normalizedAccountId, params.env),
  });
  return {
    accessToken: resolvedStrings.accessToken || undefined,
    homeserver: resolvedStrings.homeserver,
    password: resolvedStrings.password || undefined,
    userId: resolvedStrings.userId,
  };
}

function resolveMatrixAccountUserId(params: {
  cfg: CoreConfig;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const env = params.env ?? process.env;
  const authView = resolveMatrixAccountAuthView({
    accountId: params.accountId,
    cfg: params.cfg,
    env,
  });
  const configuredUserId = authView.userId.trim();
  if (configuredUserId) {
    return configuredUserId;
  }

  const stored = loadMatrixCredentials(env, params.accountId);
  if (!stored) {
    return null;
  }
  if (authView.homeserver && stored.homeserver !== authView.homeserver) {
    return null;
  }
  if (authView.accessToken && stored.accessToken !== authView.accessToken) {
    return null;
  }
  return stored.userId.trim() || null;
}

export function listMatrixAccountIds(cfg: CoreConfig): string[] {
  const ids = resolveConfiguredMatrixAccountIds(cfg, process.env);
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultMatrixAccountId(cfg: CoreConfig): string {
  return normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg));
}

export function resolveConfiguredMatrixBotUserIds(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): Set<string> {
  const env = params.env ?? process.env;
  const currentAccountId = normalizeAccountId(params.accountId);
  const accountIds = new Set(resolveConfiguredMatrixAccountIds(params.cfg, env));
  if (resolveMatrixAccount({ accountId: DEFAULT_ACCOUNT_ID, cfg: params.cfg, env }).configured) {
    accountIds.add(DEFAULT_ACCOUNT_ID);
  }
  const ids = new Set<string>();

  for (const accountId of accountIds) {
    if (normalizeAccountId(accountId) === currentAccountId) {
      continue;
    }
    if (!resolveMatrixAccount({ accountId, cfg: params.cfg, env }).configured) {
      continue;
    }
    const userId = resolveMatrixAccountUserId({
      accountId,
      cfg: params.cfg,
      env,
    });
    if (userId) {
      ids.add(userId);
    }
  }

  return ids;
}

export function resolveMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedMatrixAccount {
  const env = params.env ?? process.env;
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMatrixAccountId(params.cfg),
  );
  const matrixBase = resolveMatrixBaseConfig(params.cfg);
  const base = resolveMatrixAccountConfig({ accountId, cfg: params.cfg, env });
  const explicitAuthConfig =
    accountId === DEFAULT_ACCOUNT_ID
      ? base
      : (findMatrixAccountConfig(params.cfg, accountId) ?? {});
  const enabled = base.enabled !== false && matrixBase.enabled !== false;

  const authView = resolveMatrixAccountAuthView({
    accountId,
    cfg: params.cfg,
    env,
  });
  const hasHomeserver = Boolean(authView.homeserver);
  const hasUserId = Boolean(authView.userId);
  const hasAccessToken =
    Boolean(authView.accessToken) || hasConfiguredSecretInput(explicitAuthConfig.accessToken);
  const hasPassword = Boolean(authView.password);
  const hasPasswordAuth =
    hasUserId && (hasPassword || hasConfiguredSecretInput(explicitAuthConfig.password));
  const stored = loadMatrixCredentials(env, accountId);
  const hasStored =
    stored && authView.homeserver
      ? credentialsMatchConfig(stored, {
          homeserver: authView.homeserver,
          userId: authView.userId || "",
        })
      : false;
  const configured = hasHomeserver && (hasAccessToken || hasPasswordAuth || Boolean(hasStored));
  return {
    accountId,
    config: base,
    configured,
    enabled,
    homeserver: authView.homeserver || undefined,
    name: normalizeOptionalString(base.name),
    userId: authView.userId || undefined,
  };
}

export { resolveMatrixAccountConfig } from "./account-config.js";
