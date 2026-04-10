import {
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  createAccountListHelpers,
  normalizeAccountId,
  normalizeChatType,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SlackAccountSurfaceFields } from "./account-surface-fields.js";
import type { SlackAccountConfig } from "./runtime-api.js";
import { resolveSlackAppToken, resolveSlackBotToken, resolveSlackUserToken } from "./token.js";

export type SlackTokenSource = "env" | "config" | "none";

export type ResolvedSlackAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  appToken?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  userTokenSource: SlackTokenSource;
  config: SlackAccountConfig;
} & SlackAccountSurfaceFields;

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("slack");
export const listSlackAccountIds = listAccountIds;
export const resolveDefaultSlackAccountId = resolveDefaultAccountId;

export function mergeSlackAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SlackAccountConfig {
  return resolveMergedAccountConfig<SlackAccountConfig>({
    accountId,
    accounts: cfg.channels?.slack?.accounts as
      | Record<string, Partial<SlackAccountConfig>>
      | undefined,
    channelConfig: cfg.channels?.slack as SlackAccountConfig | undefined,
  });
}

export function resolveSlackAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSlackAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.slack?.enabled !== false;
  const merged = mergeSlackAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envBot = allowEnv ? resolveSlackBotToken(process.env.SLACK_BOT_TOKEN) : undefined;
  const envApp = allowEnv ? resolveSlackAppToken(process.env.SLACK_APP_TOKEN) : undefined;
  const envUser = allowEnv ? resolveSlackUserToken(process.env.SLACK_USER_TOKEN) : undefined;
  const configBot = resolveSlackBotToken(
    merged.botToken,
    `channels.slack.accounts.${accountId}.botToken`,
  );
  const configApp = resolveSlackAppToken(
    merged.appToken,
    `channels.slack.accounts.${accountId}.appToken`,
  );
  const configUser = resolveSlackUserToken(
    merged.userToken,
    `channels.slack.accounts.${accountId}.userToken`,
  );
  const botToken = configBot ?? envBot;
  const appToken = configApp ?? envApp;
  const userToken = configUser ?? envUser;
  const botTokenSource: SlackTokenSource = configBot ? "config" : (envBot ? "env" : "none");
  const appTokenSource: SlackTokenSource = configApp ? "config" : (envApp ? "env" : "none");
  const userTokenSource: SlackTokenSource = configUser ? "config" : (envUser ? "env" : "none");

  return {
    accountId,
    actions: merged.actions,
    appToken,
    appTokenSource,
    botToken,
    botTokenSource,
    channels: merged.channels,
    config: merged,
    dm: merged.dm,
    enabled,
    groupPolicy: merged.groupPolicy,
    mediaMaxMb: merged.mediaMaxMb,
    name: normalizeOptionalString(merged.name),
    reactionAllowlist: merged.reactionAllowlist,
    reactionNotifications: merged.reactionNotifications,
    replyToMode: merged.replyToMode,
    replyToModeByChatType: merged.replyToModeByChatType,
    slashCommand: merged.slashCommand,
    textChunkLimit: merged.textChunkLimit,
    userToken,
    userTokenSource,
  };
}

export function listEnabledSlackAccounts(cfg: OpenClawConfig): ResolvedSlackAccount[] {
  return listSlackAccountIds(cfg)
    .map((accountId) => resolveSlackAccount({ accountId, cfg }))
    .filter((account) => account.enabled);
}

export function resolveSlackReplyToMode(
  account: ResolvedSlackAccount,
  chatType?: string | null,
): "off" | "first" | "all" | "batched" {
  const normalized = normalizeChatType(chatType ?? undefined);
  if (normalized && account.replyToModeByChatType?.[normalized] !== undefined) {
    return account.replyToModeByChatType[normalized] ?? "off";
  }
  if (normalized === "direct" && account.dm?.replyToMode !== undefined) {
    return account.dm.replyToMode;
  }
  return account.replyToMode ?? "off";
}
