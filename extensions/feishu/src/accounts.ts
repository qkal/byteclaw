import {
  type OpenClawConfig as ClawdbotConfig,
  DEFAULT_ACCOUNT_ID,
  createAccountListHelpers,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { coerceSecretRef } from "openclaw/plugin-sdk/provider-auth";
import { normalizeString } from "./comment-shared.js";
import type {
  FeishuAccountConfig,
  FeishuConfig,
  FeishuDefaultAccountSelectionSource,
  FeishuDomain,
  ResolvedFeishuAccount,
} from "./types.js";

const { listAccountIds: listFeishuAccountIds, resolveDefaultAccountId } = createAccountListHelpers(
  "feishu",
  {
    allowUnlistedDefaultAccount: true,
  },
);

export { listFeishuAccountIds };

type FeishuCredentialResolutionMode = "inspect" | "strict";
type FeishuResolvedSecretRef = NonNullable<ReturnType<typeof coerceSecretRef>>;

function formatSecretRefLabel(ref: FeishuResolvedSecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

export class FeishuSecretRefUnavailableError extends Error {
  path: string;

  constructor(path: string, ref: FeishuResolvedSecretRef) {
    super(
      `${path}: unresolved SecretRef "${formatSecretRefLabel(ref)}". ` +
        "Resolve this command against an active gateway runtime snapshot before reading it.",
    );
    this.name = "FeishuSecretRefUnavailableError";
    this.path = path;
  }
}

export function isFeishuSecretRefUnavailableError(
  error: unknown,
): error is FeishuSecretRefUnavailableError {
  return error instanceof FeishuSecretRefUnavailableError;
}

function resolveFeishuSecretLike(params: {
  value: unknown;
  path: string;
  mode: FeishuCredentialResolutionMode;
  allowEnvSecretRefRead?: boolean;
}): string | undefined {
  const asString = normalizeString(params.value);
  if (asString) {
    return asString;
  }

  const ref = coerceSecretRef(params.value);
  if (!ref) {
    return undefined;
  }

  if (params.mode === "inspect") {
    if (params.allowEnvSecretRefRead && ref.source === "env") {
      const envValue = normalizeString(process.env[ref.id]);
      if (envValue) {
        return envValue;
      }
    }
    return undefined;
  }

  throw new FeishuSecretRefUnavailableError(params.path, ref);
}

function resolveFeishuBaseCredentials(
  cfg: FeishuConfig | undefined,
  mode: FeishuCredentialResolutionMode,
): {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
} | null {
  const appId = resolveFeishuSecretLike({
    allowEnvSecretRefRead: true,
    mode,
    path: "channels.feishu.appId",
    value: cfg?.appId,
  });
  const appSecret = resolveFeishuSecretLike({
    allowEnvSecretRefRead: true,
    mode,
    path: "channels.feishu.appSecret",
    value: cfg?.appSecret,
  });

  if (!appId || !appSecret) {
    return null;
  }

  return {
    appId,
    appSecret,
    domain: cfg?.domain ?? "feishu",
  };
}

function resolveFeishuEventSecrets(
  cfg: FeishuConfig | undefined,
  mode: FeishuCredentialResolutionMode,
): {
  encryptKey?: string;
  verificationToken?: string;
} {
  return {
    encryptKey:
      (cfg?.connectionMode ?? "websocket") === "webhook"
        ? resolveFeishuSecretLike({
            allowEnvSecretRefRead: true,
            mode,
            path: "channels.feishu.encryptKey",
            value: cfg?.encryptKey,
          })
        : normalizeString(cfg?.encryptKey),
    verificationToken: resolveFeishuSecretLike({
      allowEnvSecretRefRead: true,
      mode,
      path: "channels.feishu.verificationToken",
      value: cfg?.verificationToken,
    }),
  };
}

/**
 * Resolve the default account selection and its source.
 */
export function resolveDefaultFeishuAccountSelection(cfg: ClawdbotConfig): {
  accountId: string;
  source: FeishuDefaultAccountSelectionSource;
} {
  const preferred = normalizeOptionalAccountId(
    (cfg.channels?.feishu as FeishuConfig | undefined)?.defaultAccount,
  );
  if (preferred) {
    return {
      accountId: preferred,
      source: "explicit-default",
    };
  }
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      source: "mapped-default",
    };
  }
  return {
    accountId: ids[0] ?? DEFAULT_ACCOUNT_ID,
    source: "fallback",
  };
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultFeishuAccountId(cfg: ClawdbotConfig): string {
  return resolveDefaultAccountId(cfg);
}

/**
 * Merge top-level config with account-specific config.
 * Account-specific fields override top-level fields.
 */
function mergeFeishuAccountConfig(cfg: ClawdbotConfig, accountId: string): FeishuConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  return resolveMergedAccountConfig<FeishuConfig>({
    accountId,
    accounts: feishuCfg?.accounts as Record<string, Partial<FeishuConfig>> | undefined,
    channelConfig: feishuCfg,
    omitKeys: ["defaultAccount"],
  });
}

/**
 * Resolve Feishu credentials from a config.
 */
export function resolveFeishuCredentials(cfg?: FeishuConfig): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null;
export function resolveFeishuCredentials(
  cfg: FeishuConfig | undefined,
  options: {
    mode?: FeishuCredentialResolutionMode;
    allowUnresolvedSecretRef?: boolean;
  },
): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null;
export function resolveFeishuCredentials(
  cfg?: FeishuConfig,
  options?: {
    mode?: FeishuCredentialResolutionMode;
    allowUnresolvedSecretRef?: boolean;
  },
): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null {
  const mode = options?.mode ?? (options?.allowUnresolvedSecretRef ? "inspect" : "strict");
  const base = resolveFeishuBaseCredentials(cfg, mode);
  if (!base) {
    return null;
  }
  const eventSecrets = resolveFeishuEventSecrets(cfg, mode);

  return {
    ...base,
    ...eventSecrets,
  };
}

export function inspectFeishuCredentials(cfg?: FeishuConfig) {
  return resolveFeishuCredentials(cfg, { mode: "inspect" });
}

function buildResolvedFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
  baseMode: FeishuCredentialResolutionMode;
  eventSecretMode: FeishuCredentialResolutionMode;
}): ResolvedFeishuAccount {
  const hasExplicitAccountId =
    typeof params.accountId === "string" && params.accountId.trim() !== "";
  const defaultSelection = hasExplicitAccountId
    ? null
    : resolveDefaultFeishuAccountSelection(params.cfg);
  const accountId = hasExplicitAccountId
    ? normalizeAccountId(params.accountId)
    : (defaultSelection?.accountId ?? DEFAULT_ACCOUNT_ID);
  const selectionSource = hasExplicitAccountId
    ? "explicit"
    : (defaultSelection?.source ?? "fallback");
  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;

  const baseEnabled = feishuCfg?.enabled !== false;
  const merged = mergeFeishuAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const baseCreds = resolveFeishuBaseCredentials(merged, params.baseMode);
  const eventSecrets = resolveFeishuEventSecrets(merged, params.eventSecretMode);
  const accountName = (merged as FeishuAccountConfig).name;

  return {
    accountId,
    appId: baseCreds?.appId,
    appSecret: baseCreds?.appSecret,
    config: merged,
    configured: Boolean(baseCreds),
    domain: baseCreds?.domain ?? "feishu",
    enabled,
    encryptKey: eventSecrets.encryptKey,
    name: typeof accountName === "string" ? accountName.trim() || undefined : undefined,
    selectionSource,
    verificationToken: eventSecrets.verificationToken,
  };
}

/**
 * Resolve a read-only Feishu account snapshot for CLI/config surfaces.
 * Unresolved SecretRefs are treated as unavailable instead of throwing.
 */
export function resolveFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  return buildResolvedFeishuAccount({
    ...params,
    baseMode: "inspect",
    eventSecretMode: "inspect",
  });
}

/**
 * Resolve a runtime Feishu account.
 * Required app credentials stay strict; event-only secrets can be required by callers.
 */
export function resolveFeishuRuntimeAccount(
  params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
  },
  options?: { requireEventSecrets?: boolean },
): ResolvedFeishuAccount {
  return buildResolvedFeishuAccount({
    ...params,
    baseMode: "strict",
    eventSecretMode: options?.requireEventSecrets ? "strict" : "inspect",
  });
}

/**
 * List all enabled and configured accounts.
 */
export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ accountId, cfg }))
    .filter((account) => account.enabled && account.configured);
}
