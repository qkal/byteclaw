import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { fetchWithTimeout } from "openclaw/plugin-sdk/text-runtime";
import { normalizeDiscordToken } from "./token.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export type DiscordProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  bot?: { id?: string | null; username?: string | null };
  application?: DiscordApplicationSummary;
};

export type DiscordPrivilegedIntentStatus = "enabled" | "limited" | "disabled";

export interface DiscordPrivilegedIntentsSummary {
  messageContent: DiscordPrivilegedIntentStatus;
  guildMembers: DiscordPrivilegedIntentStatus;
  presence: DiscordPrivilegedIntentStatus;
}

export interface DiscordApplicationSummary {
  id?: string | null;
  flags?: number | null;
  intents?: DiscordPrivilegedIntentsSummary;
}

const DISCORD_APP_FLAG_GATEWAY_PRESENCE = 1 << 12;
const DISCORD_APP_FLAG_GATEWAY_PRESENCE_LIMITED = 1 << 13;
const DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS = 1 << 14;
const DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;
const DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 18;
const DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

async function fetchDiscordApplicationMe(
  token: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<{ id?: string; flags?: number } | undefined> {
  try {
    const appResponse = await fetchDiscordApplicationMeResponse(token, timeoutMs, fetcher);
    if (!appResponse || !appResponse.ok) {
      return undefined;
    }
    return (await appResponse.json()) as { id?: string; flags?: number };
  } catch {
    return undefined;
  }
}

async function fetchDiscordApplicationMeResponse(
  token: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<Response | undefined> {
  const normalized = normalizeDiscordToken(token, "channels.discord.token");
  if (!normalized) {
    return undefined;
  }
  return await fetchWithTimeout(
    `${DISCORD_API_BASE}/oauth2/applications/@me`,
    { headers: { Authorization: `Bot ${normalized}` } },
    timeoutMs,
    getResolvedFetch(fetcher),
  );
}

export function resolveDiscordPrivilegedIntentsFromFlags(
  flags: number,
): DiscordPrivilegedIntentsSummary {
  const resolve = (enabledBit: number, limitedBit: number) => {
    if ((flags & enabledBit) !== 0) {
      return "enabled";
    }
    if ((flags & limitedBit) !== 0) {
      return "limited";
    }
    return "disabled";
  };
  return {
    guildMembers: resolve(
      DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS,
      DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED,
    ),
    messageContent: resolve(
      DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT,
      DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED,
    ),
    presence: resolve(DISCORD_APP_FLAG_GATEWAY_PRESENCE, DISCORD_APP_FLAG_GATEWAY_PRESENCE_LIMITED),
  };
}

export async function fetchDiscordApplicationSummary(
  token: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<DiscordApplicationSummary | undefined> {
  const json = await fetchDiscordApplicationMe(token, timeoutMs, fetcher);
  if (!json) {
    return undefined;
  }
  const flags =
    typeof json.flags === "number" && Number.isFinite(json.flags) ? json.flags : undefined;
  return {
    flags: flags ?? null,
    id: json.id ?? null,
    intents:
      typeof flags === "number" ? resolveDiscordPrivilegedIntentsFromFlags(flags) : undefined,
  };
}

function getResolvedFetch(fetcher: typeof fetch): typeof fetch {
  const fetchImpl = resolveFetch(fetcher);
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  return fetchImpl;
}

export async function probeDiscord(
  token: string,
  timeoutMs: number,
  opts?: { fetcher?: typeof fetch; includeApplication?: boolean },
): Promise<DiscordProbe> {
  const started = Date.now();
  const fetcher = opts?.fetcher ?? fetch;
  const includeApplication = opts?.includeApplication === true;
  const normalized = normalizeDiscordToken(token, "channels.discord.token");
  const result: DiscordProbe = {
    elapsedMs: 0,
    error: null,
    ok: false,
    status: null,
  };
  if (!normalized) {
    return {
      ...result,
      elapsedMs: Date.now() - started,
      error: "missing token",
    };
  }
  try {
    const res = await fetchWithTimeout(
      `${DISCORD_API_BASE}/users/@me`,
      { headers: { Authorization: `Bot ${normalized}` } },
      timeoutMs,
      getResolvedFetch(fetcher),
    );
    if (!res.ok) {
      result.status = res.status;
      result.error = `getMe failed (${res.status})`;
      return { ...result, elapsedMs: Date.now() - started };
    }
    const json = (await res.json()) as { id?: string; username?: string };
    result.ok = true;
    result.bot = {
      id: json.id ?? null,
      username: json.username ?? null,
    };
    if (includeApplication) {
      result.application =
        (await fetchDiscordApplicationSummary(normalized, timeoutMs, fetcher)) ?? undefined;
    }
    return { ...result, elapsedMs: Date.now() - started };
  } catch (error) {
    return {
      ...result,
      elapsedMs: Date.now() - started,
      error: formatErrorMessage(error),
      status: error instanceof Response ? error.status : result.status,
    };
  }
}

/**
 * Extract the application (bot user) ID from a Discord bot token by
 * base64-decoding the first segment.  Discord tokens have the format:
 *   base64(user_id) . timestamp . hmac
 * The decoded first segment is the numeric snowflake ID as a plain string,
 * so we keep it as a string to avoid precision loss for IDs that exceed
 * Number.MAX_SAFE_INTEGER.
 */
export function parseApplicationIdFromToken(token: string): string | undefined {
  const normalized = normalizeDiscordToken(token, "channels.discord.token");
  if (!normalized) {
    return undefined;
  }
  const firstDot = normalized.indexOf(".");
  if (firstDot <= 0) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(normalized.slice(0, firstDot), "base64").toString("utf8");
    if (/^\d+$/.test(decoded)) {
      return decoded;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function fetchDiscordApplicationId(
  token: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const normalized = normalizeDiscordToken(token, "channels.discord.token");
  if (!normalized) {
    return undefined;
  }
  try {
    const res = await fetchDiscordApplicationMeResponse(token, timeoutMs, fetcher);
    if (!res) {
      return undefined;
    }
    if (res.ok) {
      const json = (await res.json()) as { id?: string };
      if (json?.id) {
        return json.id;
      }
    }
    // Non-ok HTTP response (401, 403, etc.) — fail fast so credential
    // Errors surface immediately rather than being masked by the fallback.
    return undefined;
  } catch {
    // Transport / timeout error — fall back to extracting the application
    // ID directly from the token to keep the bot starting.
    return parseApplicationIdFromToken(token);
  }
}
