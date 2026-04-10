import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/channel-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  createAccountListHelpers,
  normalizeAccountId,
  resolveAccountWithDefaultFallback,
} from "../runtime-api.js";
import { normalizeResolvedSecretInputString } from "./secret-input.js";
import type { CoreConfig, NextcloudTalkAccountConfig } from "./types.js";

function isTruthyEnvValue(value?: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_NEXTCLOUD_TALK_ACCOUNTS)) {
    console.warn("[nextcloud-talk:accounts]", ...args);
  }
};

export interface ResolvedNextcloudTalkAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  secret: string;
  secretSource: "env" | "secretFile" | "config" | "none";
  config: NextcloudTalkAccountConfig;
}

const {
  listAccountIds: listNextcloudTalkAccountIdsInternal,
  resolveDefaultAccountId: resolveDefaultNextcloudTalkAccountId,
} = createAccountListHelpers("nextcloud-talk", {
  normalizeAccountId,
});
export { resolveDefaultNextcloudTalkAccountId };

export function listNextcloudTalkAccountIds(cfg: CoreConfig): string[] {
  const ids = listNextcloudTalkAccountIdsInternal(cfg);
  debugAccounts("listNextcloudTalkAccountIds", ids);
  return ids;
}

function mergeNextcloudTalkAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): NextcloudTalkAccountConfig {
  return resolveMergedAccountConfig<NextcloudTalkAccountConfig>({
    accountId,
    accounts: cfg.channels?.["nextcloud-talk"]?.accounts as
      | Record<string, Partial<NextcloudTalkAccountConfig>>
      | undefined,
    channelConfig: cfg.channels?.["nextcloud-talk"] as NextcloudTalkAccountConfig | undefined,
    normalizeAccountId,
    omitKeys: ["defaultAccount"],
  });
}

function resolveNextcloudTalkSecret(
  cfg: CoreConfig,
  opts: { accountId?: string },
): { secret: string; source: ResolvedNextcloudTalkAccount["secretSource"] } {
  const resolvedAccountId = opts.accountId ?? resolveDefaultNextcloudTalkAccountId(cfg);
  const merged = mergeNextcloudTalkAccountConfig(cfg, resolvedAccountId);

  const envSecret = normalizeOptionalString(process.env.NEXTCLOUD_TALK_BOT_SECRET);
  if (envSecret && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    return { secret: envSecret, source: "env" };
  }

  if (merged.botSecretFile) {
    const fileSecret = tryReadSecretFileSync(
      merged.botSecretFile,
      "Nextcloud Talk bot secret file",
      { rejectSymlink: true },
    );
    if (fileSecret) {
      return { secret: fileSecret, source: "secretFile" };
    }
  }

  const inlineSecret = normalizeResolvedSecretInputString({
    path: `channels.nextcloud-talk.accounts.${resolvedAccountId}.botSecret`,
    value: merged.botSecret,
  });
  if (inlineSecret) {
    return { secret: inlineSecret, source: "config" };
  }

  return { secret: "", source: "none" };
}

export function resolveNextcloudTalkAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedNextcloudTalkAccount {
  const baseEnabled = params.cfg.channels?.["nextcloud-talk"]?.enabled !== false;
  const resolvedAccountId = params.accountId ?? resolveDefaultNextcloudTalkAccountId(params.cfg);

  const resolve = (accountId: string) => {
    const merged = mergeNextcloudTalkAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const secretResolution = resolveNextcloudTalkSecret(params.cfg, { accountId });
    const baseUrl = merged.baseUrl?.trim()?.replace(/\/$/, "") ?? "";

    debugAccounts("resolve", {
      accountId,
      baseUrl: baseUrl ? "[set]" : "[missing]",
      enabled,
      secretSource: secretResolution.source,
    });

    return {
      accountId,
      baseUrl,
      config: merged,
      enabled,
      name: normalizeOptionalString(merged.name),
      secret: secretResolution.secret,
      secretSource: secretResolution.source,
    } satisfies ResolvedNextcloudTalkAccount;
  };

  return resolveAccountWithDefaultFallback({
    accountId: resolvedAccountId,
    hasCredential: (account) => account.secretSource !== "none",
    normalizeAccountId,
    resolveDefaultAccountId: () => resolveDefaultNextcloudTalkAccountId(params.cfg),
    resolvePrimary: resolve,
  });
}

export function listEnabledNextcloudTalkAccounts(cfg: CoreConfig): ResolvedNextcloudTalkAccount[] {
  return listNextcloudTalkAccountIds(cfg)
    .map((accountId) => resolveNextcloudTalkAccount({ accountId, cfg }))
    .filter((account) => account.enabled);
}
