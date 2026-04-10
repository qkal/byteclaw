import { mapAllowlistResolutionInputs } from "openclaw/plugin-sdk/allow-from";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import { searchGraphUsers } from "./graph-users.js";
import {
  listChannelsForTeam,
  listTeamsByName,
  normalizeQuery,
  resolveGraphToken,
} from "./graph.js";

export interface MSTeamsChannelResolution {
  input: string;
  resolved: boolean;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
  note?: string;
}

export interface MSTeamsUserResolution {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
}

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(msteams|teams):/i, "");
}

export function normalizeMSTeamsMessagingTarget(raw: string): string | undefined {
  let trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  trimmed = stripProviderPrefix(trimmed).trim();
  if (/^conversation:/i.test(trimmed)) {
    const id = trimmed.slice("conversation:".length).trim();
    return id ? `conversation:${id}` : undefined;
  }
  if (/^user:/i.test(trimmed)) {
    const id = trimmed.slice("user:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  return trimmed || undefined;
}

export function normalizeMSTeamsUserInput(raw: string): string {
  return stripProviderPrefix(raw)
    .replace(/^(user|conversation):/i, "")
    .trim();
}

export function parseMSTeamsConversationId(raw: string): string | null {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!/^conversation:/i.test(trimmed)) {
    return null;
  }
  const id = trimmed.slice("conversation:".length).trim();
  return id;
}

/**
 * Detect whether a raw target string looks like a Microsoft Teams conversation
 * or user id that cron announce delivery and other explicit-target paths can
 * forward verbatim to the channel adapter.
 *
 * Accepts both prefixed and bare formats:
 * - `conversation:<id>` — explicit conversation prefix
 * - `user:<aad-guid>`   — user id (16+ hex chars, UUID-like)
 * - `19:abc@thread.tacv2` / `19:abc@thread.skype` — channel / legacy group
 * - `19:{userId}_{appId}@unq.gbl.spaces` — Graph 1:1 chat thread format
 * - `a:1xxx` — Bot Framework personal (1:1) chat id
 * - `8:orgid:xxx` — Bot Framework org-scoped personal chat id
 * - `29:xxx` — Bot Framework user id
 *
 * Display-name user targets such as `user:John Smith` intentionally return
 * false so that the Graph API directory lookup still runs for them.
 */
export function looksLikeMSTeamsTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^conversation:/i.test(trimmed)) {
    return true;
  }
  if (/^user:/i.test(trimmed)) {
    // Only treat as an id when the value after `user:` looks like a UUID;
    // Display names must fall through to directory lookup.
    const id = trimmed.slice("user:".length).trim();
    return /^[0-9a-fA-F-]{16,}$/.test(id);
  }
  // Bare Bot Framework / Graph conversation id formats.
  // Channel / group ids always start with `19:` and include an `@thread.*`
  // Suffix (`@thread.tacv2` or the legacy `@thread.skype`). Personal chat
  // Ids come in three shapes: `a:1...` (Bot Framework), `8:orgid:...`
  // (org-scoped Bot Framework), and `19:{userId}_{appId}@unq.gbl.spaces`
  // (Graph API 1:1 chat thread). Bot Framework user ids use `29:...`.
  if (/^19:.+@thread\.(tacv2|skype)$/i.test(trimmed)) {
    return true;
  }
  if (/^19:.+@unq\.gbl\.spaces$/i.test(trimmed)) {
    return true;
  }
  if (/^a:1[A-Za-z0-9_-]+$/i.test(trimmed)) {
    return true;
  }
  if (/^8:orgid:[A-Za-z0-9-]+$/i.test(trimmed)) {
    return true;
  }
  if (/^29:[A-Za-z0-9_-]+$/i.test(trimmed)) {
    return true;
  }
  // Fallback: anything containing @thread is still treated as a conversation
  // Id so the current matches for tenant-specific suffixes remain accepted.
  return /@thread\b/i.test(trimmed);
}

function normalizeMSTeamsTeamKey(raw: string): string | undefined {
  const trimmed = stripProviderPrefix(raw)
    .replace(/^team:/i, "")
    .trim();
  return trimmed || undefined;
}

function normalizeMSTeamsChannelKey(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^#/, "").trim() ?? "";
  return trimmed || undefined;
}

export function parseMSTeamsTeamChannelInput(raw: string): { team?: string; channel?: string } {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!trimmed) {
    return {};
  }
  const parts = trimmed.split("/");
  const team = normalizeMSTeamsTeamKey(parts[0] ?? "");
  const channel =
    parts.length > 1 ? normalizeMSTeamsChannelKey(parts.slice(1).join("/")) : undefined;
  return {
    ...(team ? { team } : {}),
    ...(channel ? { channel } : {}),
  };
}

export function parseMSTeamsTeamEntry(
  raw: string,
): { teamKey: string; channelKey?: string } | null {
  const { team, channel } = parseMSTeamsTeamChannelInput(raw);
  if (!team) {
    return null;
  }
  return {
    teamKey: team,
    ...(channel ? { channelKey: channel } : {}),
  };
}

export async function resolveMSTeamsChannelAllowlist(params: {
  cfg: unknown;
  entries: string[];
}): Promise<MSTeamsChannelResolution[]> {
  const token = await resolveGraphToken(params.cfg);
  return await mapAllowlistResolutionInputs({
    inputs: params.entries,
    mapInput: async (input): Promise<MSTeamsChannelResolution> => {
      const { team, channel } = parseMSTeamsTeamChannelInput(input);
      if (!team) {
        return { input, resolved: false };
      }
      const teams = /^[0-9a-fA-F-]{16,}$/.test(team)
        ? [{ displayName: team, id: team }]
        : await listTeamsByName(token, team);
      if (teams.length === 0) {
        return { input, note: "team not found", resolved: false };
      }
      const teamMatch = teams[0];
      const graphTeamId = teamMatch.id?.trim();
      const teamName = teamMatch.displayName?.trim() || team;
      if (!graphTeamId) {
        return { input, note: "team id missing", resolved: false };
      }
      // Bot Framework sends the General channel's conversation ID as
      // ChannelData.team.id at runtime, NOT the Graph API group GUID.
      // Fetch channels upfront so we can resolve the correct key format for
      // Runtime matching and reuse the list for channel lookups.
      let teamChannels: Awaited<ReturnType<typeof listChannelsForTeam>> = [];
      try {
        teamChannels = await listChannelsForTeam(token, graphTeamId);
      } catch {
        // API failure (rate limit, network error) — fall back to Graph GUID as team key
      }
      const generalChannel = teamChannels.find(
        (ch) => normalizeOptionalLowercaseString(ch.displayName) === "general",
      );
      // Use the General channel's conversation ID as the team key — this
      // Matches what Bot Framework sends at runtime. Fall back to the Graph
      // GUID if the General channel isn't found (renamed or deleted).
      const teamId = generalChannel?.id?.trim() || graphTeamId;
      if (!channel) {
        return {
          input,
          note: teams.length > 1 ? "multiple teams; chose first" : undefined,
          resolved: true,
          teamId,
          teamName,
        };
      }
      // Reuse teamChannels — already fetched above
      const normalizedChannel = normalizeOptionalLowercaseString(channel);
      const channelMatch =
        teamChannels.find((item) => item.id === channel) ??
        teamChannels.find(
          (item) => normalizeOptionalLowercaseString(item.displayName) === normalizedChannel,
        ) ??
        teamChannels.find((item) =>
          normalizeLowercaseStringOrEmpty(item.displayName ?? "").includes(normalizedChannel ?? ""),
        );
      if (!channelMatch?.id) {
        return { input, note: "channel not found", resolved: false };
      }
      return {
        channelId: channelMatch.id,
        channelName: channelMatch.displayName ?? channel,
        input,
        note: teamChannels.length > 1 ? "multiple channels; chose first" : undefined,
        resolved: true,
        teamId,
        teamName,
      };
    },
  });
}

export async function resolveMSTeamsUserAllowlist(params: {
  cfg: unknown;
  entries: string[];
}): Promise<MSTeamsUserResolution[]> {
  const token = await resolveGraphToken(params.cfg);
  return await mapAllowlistResolutionInputs({
    inputs: params.entries,
    mapInput: async (input): Promise<MSTeamsUserResolution> => {
      const query = normalizeQuery(normalizeMSTeamsUserInput(input));
      if (!query) {
        return { input, resolved: false };
      }
      if (/^[0-9a-fA-F-]{16,}$/.test(query)) {
        return { id: query, input, resolved: true };
      }
      const users = await searchGraphUsers({ query, token, top: 10 });
      const match = users[0];
      if (!match?.id) {
        return { input, resolved: false };
      }
      return {
        id: match.id,
        input,
        name: match.displayName ?? undefined,
        note: users.length > 1 ? "multiple matches; chose first" : undefined,
        resolved: true,
      };
    },
  });
}
