import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  type MattermostClient,
  type MattermostFetch,
  createMattermostClient,
  fetchMattermostMe,
} from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

type Result = { ok: true } | { ok: false; error: string };
interface ReactionParams {
  cfg: OpenClawConfig;
  postId: string;
  emojiName: string;
  accountId?: string | null;
  fetchImpl?: MattermostFetch;
}
type ReactionMutation = (client: MattermostClient, params: MutationPayload) => Promise<void>;
interface MutationPayload { userId: string; postId: string; emojiName: string }

const BOT_USER_CACHE_TTL_MS = 10 * 60_000;
const botUserIdCache = new Map<string, { userId: string; expiresAt: number }>();

async function resolveBotUserId(
  client: MattermostClient,
  cacheKey: string,
): Promise<string | null> {
  const cached = botUserIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.userId;
  }
  const me = await fetchMattermostMe(client);
  const userId = me?.id?.trim();
  if (!userId) {
    return null;
  }
  botUserIdCache.set(cacheKey, { expiresAt: Date.now() + BOT_USER_CACHE_TTL_MS, userId });
  return userId;
}

export async function addMattermostReaction(params: {
  cfg: OpenClawConfig;
  postId: string;
  emojiName: string;
  accountId?: string | null;
  fetchImpl?: MattermostFetch;
}): Promise<Result> {
  return runMattermostReaction(params, {
    action: "add",
    mutation: createReaction,
  });
}

export async function removeMattermostReaction(params: {
  cfg: OpenClawConfig;
  postId: string;
  emojiName: string;
  accountId?: string | null;
  fetchImpl?: MattermostFetch;
}): Promise<Result> {
  return runMattermostReaction(params, {
    action: "remove",
    mutation: deleteReaction,
  });
}

export function resetMattermostReactionBotUserCacheForTests(): void {
  botUserIdCache.clear();
}

async function runMattermostReaction(
  params: ReactionParams,
  options: {
    action: "add" | "remove";
    mutation: ReactionMutation;
  },
): Promise<Result> {
  const resolved = resolveMattermostAccount({ accountId: params.accountId, cfg: params.cfg });
  const baseUrl = resolved.baseUrl?.trim();
  const botToken = resolved.botToken?.trim();
  if (!baseUrl || !botToken) {
    return { error: "Mattermost botToken/baseUrl missing.", ok: false };
  }

  const client = createMattermostClient({
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(resolved.config),
    baseUrl,
    botToken,
    fetchImpl: params.fetchImpl,
  });

  const cacheKey = `${baseUrl}:${botToken}`;
  const userId = await resolveBotUserId(client, cacheKey);
  if (!userId) {
    return { error: "Mattermost reactions failed: could not resolve bot user id.", ok: false };
  }

  try {
    await options.mutation(client, {
      emojiName: params.emojiName,
      postId: params.postId,
      userId,
    });
  } catch (error) {
    return { error: `Mattermost ${options.action} reaction failed: ${String(error)}`, ok: false };
  }

  return { ok: true };
}

async function createReaction(client: MattermostClient, params: MutationPayload): Promise<void> {
  await client.request<Record<string, unknown>>("/reactions", {
    body: JSON.stringify({
      emoji_name: params.emojiName,
      post_id: params.postId,
      user_id: params.userId,
    }),
    method: "POST",
  });
}

async function deleteReaction(client: MattermostClient, params: MutationPayload): Promise<void> {
  const emoji = encodeURIComponent(params.emojiName);
  await client.request<unknown>(
    `/users/${params.userId}/posts/${params.postId}/reactions/${emoji}`,
    {
      method: "DELETE",
    },
  );
}
