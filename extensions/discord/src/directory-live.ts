import type {
  ChannelDirectoryEntry,
  DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { fetchDiscord } from "./api.js";
import { rememberDiscordDirectoryUser } from "./directory-cache.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import { normalizeDiscordToken } from "./token.js";

interface DiscordGuild { id: string; name: string }
interface DiscordUser { id: string; username: string; global_name?: string; bot?: boolean }
interface DiscordMember { user: DiscordUser; nick?: string | null }
interface DiscordChannel { id: string; name?: string | null }
interface DiscordDirectoryAccess { token: string; query: string; accountId: string }

function normalizeQuery(value?: string | null): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

function buildUserRank(user: DiscordUser): number {
  return user.bot ? 0 : 1;
}

function resolveDiscordDirectoryAccess(
  params: DirectoryConfigParams,
): DiscordDirectoryAccess | null {
  const account = resolveDiscordAccount({ accountId: params.accountId, cfg: params.cfg });
  const token = normalizeDiscordToken(account.token, "channels.discord.token");
  if (!token) {
    return null;
  }
  return { accountId: account.accountId, query: normalizeQuery(params.query), token };
}

async function listDiscordGuilds(token: string): Promise<DiscordGuild[]> {
  const rawGuilds = await fetchDiscord<DiscordGuild[]>("/users/@me/guilds", token);
  return rawGuilds.filter((guild) => guild.id && guild.name);
}

export async function listDiscordDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const access = resolveDiscordDirectoryAccess(params);
  if (!access) {
    return [];
  }
  const { token, query } = access;
  const guilds = await listDiscordGuilds(token);
  const rows: ChannelDirectoryEntry[] = [];

  for (const guild of guilds) {
    const channels = await fetchDiscord<DiscordChannel[]>(`/guilds/${guild.id}/channels`, token);
    for (const channel of channels) {
      const name = channel.name?.trim();
      if (!name) {
        continue;
      }
      if (query && !normalizeDiscordSlug(name).includes(normalizeDiscordSlug(query))) {
        continue;
      }
      rows.push({
        handle: `#${name}`,
        id: `channel:${channel.id}`,
        kind: "group",
        name,
        raw: channel,
      });
      if (typeof params.limit === "number" && params.limit > 0 && rows.length >= params.limit) {
        return rows;
      }
    }
  }

  return rows;
}

export async function listDiscordDirectoryPeersLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const access = resolveDiscordDirectoryAccess(params);
  if (!access) {
    return [];
  }
  const { token, query, accountId } = access;
  if (!query) {
    return [];
  }

  const guilds = await listDiscordGuilds(token);
  const rows: ChannelDirectoryEntry[] = [];
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 25;

  for (const guild of guilds) {
    const paramsObj = new URLSearchParams({
      limit: String(Math.min(limit, 100)),
      query,
    });
    const members = await fetchDiscord<DiscordMember[]>(
      `/guilds/${guild.id}/members/search?${paramsObj.toString()}`,
      token,
    );
    for (const member of members) {
      const {user} = member;
      if (!user?.id) {
        continue;
      }
      rememberDiscordDirectoryUser({
        accountId,
        handles: [
          user.username,
          user.global_name,
          member.nick,
          user.username ? `@${user.username}` : null,
        ],
        userId: user.id,
      });
      const name = member.nick?.trim() || user.global_name?.trim() || user.username?.trim();
      rows.push({
        handle: user.username ? `@${user.username}` : undefined,
        id: `user:${user.id}`,
        kind: "user",
        name: name || undefined,
        rank: buildUserRank(user),
        raw: member,
      });
      if (rows.length >= limit) {
        return rows;
      }
    }
  }

  return rows;
}
