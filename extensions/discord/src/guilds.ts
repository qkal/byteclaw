import { fetchDiscord } from "./api.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";

export interface DiscordGuildSummary {
  id: string;
  name: string;
  slug: string;
}

export async function listGuilds(
  token: string,
  fetcher: typeof fetch,
): Promise<DiscordGuildSummary[]> {
  const raw = await fetchDiscord<{ id?: string; name?: string }[]>(
    "/users/@me/guilds",
    token,
    fetcher,
  );
  return raw
    .filter(
      (guild): guild is { id: string; name: string } =>
        typeof guild.id === "string" && typeof guild.name === "string",
    )
    .map((guild) => ({
      id: guild.id,
      name: guild.name,
      slug: normalizeDiscordSlug(guild.name),
    }));
}
