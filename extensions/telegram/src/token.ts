import { resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-core";
import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

export type TelegramTokenSource = "env" | "tokenFile" | "config" | "none";

export type TelegramTokenResolution = BaseTokenResolution & {
  source: TelegramTokenSource;
};

interface ResolveTelegramTokenOpts {
  envToken?: string | null;
  accountId?: string | null;
  logMissingFile?: (message: string) => void;
}

export function resolveTelegramToken(
  cfg?: OpenClawConfig,
  opts: ResolveTelegramTokenOpts = {},
): TelegramTokenResolution {
  const accountId = normalizeAccountId(opts.accountId);
  const telegramCfg = cfg?.channels?.telegram;

  // Account IDs are normalized for routing (e.g. lowercased). Config keys may not
  // Be normalized, so resolve per-account config by matching normalized IDs.
  const resolveAccountCfg = (id: string): TelegramAccountConfig | undefined => {
    const accounts = telegramCfg?.accounts;
    return Array.isArray(accounts)
      ? undefined
      : resolveNormalizedAccountEntry(accounts, id, normalizeAccountId);
  };

  const accountCfg = resolveAccountCfg(
    accountId !== DEFAULT_ACCOUNT_ID ? accountId : DEFAULT_ACCOUNT_ID,
  );

  // When a non-default accountId is explicitly specified but not found in config,
  // Decide whether to fall through to channel-level defaults based on whether
  // The config has an explicit accounts section (multi-bot setup).
  //
  // Multi-bot: accounts section exists with entries → block fallthrough to prevent
  // Routing via the wrong bot's token.
  //
  // Single-bot: no accounts section (or empty) → allow fallthrough so that
  // Binding-created accountIds inherit the channel-level token.
  // See: https://github.com/openclaw/openclaw/issues/53876
  if (accountId !== DEFAULT_ACCOUNT_ID && !accountCfg) {
    const accounts = telegramCfg?.accounts;
    const hasConfiguredAccounts =
      Boolean(accounts) &&
      typeof accounts === "object" &&
      !Array.isArray(accounts) &&
      Object.keys(accounts).length > 0;
    if (hasConfiguredAccounts) {
      opts.logMissingFile?.(
        `channels.telegram.accounts: unknown accountId "${accountId}" — not found in config, refusing channel-level fallback`,
      );
      return { source: "none", token: "" };
    }
  }

  const accountTokenFile = accountCfg?.tokenFile?.trim();
  if (accountTokenFile) {
    const token = tryReadSecretFileSync(
      accountTokenFile,
      `channels.telegram.accounts.${accountId}.tokenFile`,
      { rejectSymlink: true },
    );
    if (token) {
      return { source: "tokenFile", token };
    }
    opts.logMissingFile?.(
      `channels.telegram.accounts.${accountId}.tokenFile not found or unreadable: ${accountTokenFile}`,
    );
    return { source: "none", token: "" };
  }

  const accountToken = normalizeResolvedSecretInputString({
    path: `channels.telegram.accounts.${accountId}.botToken`,
    value: accountCfg?.botToken,
  });
  if (accountToken) {
    return { source: "config", token: accountToken };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const tokenFile = telegramCfg?.tokenFile?.trim();
  if (tokenFile) {
    const token = tryReadSecretFileSync(tokenFile, "channels.telegram.tokenFile", {
      rejectSymlink: true,
    });
    if (token) {
      return { source: "tokenFile", token };
    }
    opts.logMissingFile?.(`channels.telegram.tokenFile not found or unreadable: ${tokenFile}`);
    return { source: "none", token: "" };
  }

  const configToken = normalizeResolvedSecretInputString({
    path: "channels.telegram.botToken",
    value: telegramCfg?.botToken,
  });
  if (configToken) {
    return { source: "config", token: configToken };
  }

  const envToken = allowEnv ? (opts.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim() : "";
  if (envToken) {
    return { source: "env", token: envToken };
  }

  return { source: "none", token: "" };
}
