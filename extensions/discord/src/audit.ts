import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { inspectDiscordAccount } from "./account-inspect.js";
import {
  type DiscordChannelPermissionsAudit,
  auditDiscordChannelPermissionsWithFetcher,
  collectDiscordAuditChannelIdsForGuilds,
} from "./audit-core.js";
import { fetchChannelPermissionsDiscord } from "./send.js";

export function collectDiscordAuditChannelIds(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const account = inspectDiscordAccount({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  return collectDiscordAuditChannelIdsForGuilds(account.config.guilds);
}

export async function auditDiscordChannelPermissions(params: {
  token: string;
  accountId?: string | null;
  channelIds: string[];
  timeoutMs: number;
}): Promise<DiscordChannelPermissionsAudit> {
  return await auditDiscordChannelPermissionsWithFetcher({
    ...params,
    fetchChannelPermissions: fetchChannelPermissionsDiscord,
  });
}
