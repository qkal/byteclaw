import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { listMattermostAccountIds, resolveMattermostAccount } from "./accounts.js";
import {
  type MattermostChannel,
  type MattermostClient,
  type MattermostUser,
  createMattermostClient,
  fetchMattermostMe,
} from "./client.js";
import type { ChannelDirectoryEntry, OpenClawConfig, RuntimeEnv } from "./runtime-api.js";

export interface MattermostDirectoryParams {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
  runtime: RuntimeEnv;
}

function buildClient(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): MattermostClient | null {
  const account = resolveMattermostAccount({ accountId: params.accountId, cfg: params.cfg });
  if (!account.enabled || !account.botToken || !account.baseUrl) {
    return null;
  }
  return createMattermostClient({
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
    baseUrl: account.baseUrl,
    botToken: account.botToken,
  });
}

/**
 * Build clients from ALL enabled accounts (deduplicated by token).
 *
 * We always scan every account because:
 * - Private channels are only visible to bots that are members
 * - The requesting agent's account may have an expired/invalid token
 *
 * This means a single healthy bot token is enough for directory discovery.
 */
function buildClients(params: MattermostDirectoryParams): MattermostClient[] {
  const accountIds = listMattermostAccountIds(params.cfg);
  const seen = new Set<string>();
  const clients: MattermostClient[] = [];
  for (const id of accountIds) {
    const client = buildClient({ accountId: id, cfg: params.cfg });
    if (client && !seen.has(client.token)) {
      seen.add(client.token);
      clients.push(client);
    }
  }
  return clients;
}

/**
 * List channels (public + private) visible to any configured bot account.
 *
 * NOTE: Uses per_page=200 which covers most instances. Mattermost does not
 * return a "has more" indicator, so very large instances (200+ channels per bot)
 * may see incomplete results. Pagination can be added if needed.
 */
export async function listMattermostDirectoryGroups(
  params: MattermostDirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const clients = buildClients(params);
  if (!clients.length) {
    return [];
  }
  const q = normalizeLowercaseStringOrEmpty(params.query);
  const seenIds = new Set<string>();
  const entries: ChannelDirectoryEntry[] = [];

  for (const client of clients) {
    try {
      const me = await fetchMattermostMe(client);
      const channels = await client.request<MattermostChannel[]>(
        `/users/${me.id}/channels?per_page=200`,
      );
      for (const ch of channels) {
        if (ch.type !== "O" && ch.type !== "P") {
          continue;
        }
        if (seenIds.has(ch.id)) {
          continue;
        }
        if (q) {
          const name = normalizeLowercaseStringOrEmpty(ch.name);
          const display = normalizeLowercaseStringOrEmpty(ch.display_name);
          if (!name.includes(q) && !display.includes(q)) {
            continue;
          }
        }
        seenIds.add(ch.id);
        entries.push({
          handle: ch.display_name ?? undefined,
          id: `channel:${ch.id}`,
          kind: "group" as const,
          name: ch.name ?? undefined,
        });
      }
    } catch (error) {
      // Token may be expired/revoked — skip this account and try others
      console.debug?.(
        "[mattermost-directory] listGroups: skipping account:",
        (error as Error)?.message,
      );
      continue;
    }
  }
  return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
}

/**
 * List team members as peer directory entries.
 *
 * Uses only the first available client since all bots in a team see the same
 * user list (unlike channels where membership varies). Uses the first team
 * returned — multi-team setups will only see members from that team.
 *
 * NOTE: per_page=200 for member listing; same pagination caveat as groups.
 */
export async function listMattermostDirectoryPeers(
  params: MattermostDirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const clients = buildClients(params);
  if (!clients.length) {
    return [];
  }
  // All bots see the same user list, so one client suffices (unlike channels
  // Where private channel membership varies per bot).
  const client = clients[0];
  try {
    const me = await fetchMattermostMe(client);
    const teams = await client.request<{ id: string }[]>("/users/me/teams");
    if (!teams.length) {
      return [];
    }
    // Uses first team — multi-team setups may need iteration in the future
    const teamId = teams[0].id;
    const q = normalizeLowercaseStringOrEmpty(params.query);

    let users: MattermostUser[];
    if (q) {
      users = await client.request<MattermostUser[]>("/users/search", {
        body: JSON.stringify({ team_id: teamId, term: q }),
        method: "POST",
      });
    } else {
      const members = await client.request<{ user_id: string }[]>(
        `/teams/${teamId}/members?per_page=200`,
      );
      const userIds = members.map((m) => m.user_id).filter((id) => id !== me.id);
      if (!userIds.length) {
        return [];
      }
      users = await client.request<MattermostUser[]>("/users/ids", {
        body: JSON.stringify(userIds),
        method: "POST",
      });
    }

    const entries = users
      .filter((u) => u.id !== me.id)
      .map((u) => ({
        handle:
          [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.nickname || undefined,
        id: `user:${u.id}`,
        kind: "user" as const,
        name: u.username ?? undefined,
      }));
    return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
  } catch (error) {
    console.debug?.("[mattermost-directory] listPeers failed:", (error as Error)?.message);
    return [];
  }
}
