import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawConfig } from "../runtime-api.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import {
  type GraphResponse,
  deleteGraphRequest,
  escapeOData,
  fetchGraphJson,
  postGraphBetaJson,
  postGraphJson,
  resolveGraphToken,
} from "./graph.js";

interface GraphMessageBody {
  content?: string;
  contentType?: string;
}

interface GraphMessageFrom {
  user?: { id?: string; displayName?: string };
  application?: { id?: string; displayName?: string };
}

interface GraphMessage {
  id?: string;
  body?: GraphMessageBody;
  from?: GraphMessageFrom;
  createdDateTime?: string;
}

interface GraphPinnedMessage {
  id?: string;
  message?: GraphMessage;
}

interface GraphPinnedMessagesResponse {
  value?: GraphPinnedMessage[];
}

/**
 * Resolve the Graph API path prefix for a conversation.
 * If `to` contains "/" it's a `teamId/channelId` (channel path),
 * otherwise it's a chat ID.
 */
/**
 * Strip common target prefixes (`conversation:`, `user:`) so raw
 * conversation IDs can be used directly in Graph paths.
 */
function stripTargetPrefix(raw: string): string {
  const trimmed = raw.trim();
  if (/^conversation:/i.test(trimmed)) {
    return trimmed.slice("conversation:".length).trim();
  }
  if (/^user:/i.test(trimmed)) {
    return trimmed.slice("user:".length).trim();
  }
  return trimmed;
}

/**
 * Resolve a target to a Graph-compatible conversation ID.
 * `user:<aadId>` targets are looked up in the conversation store to find the
 * actual `19:xxx@thread.*` chat ID that Graph API requires.
 * Conversation IDs and `teamId/channelId` pairs pass through unchanged.
 */
async function resolveGraphConversationId(to: string): Promise<string> {
  const trimmed = to.trim();
  const isUserTarget = /^user:/i.test(trimmed);
  const cleaned = stripTargetPrefix(trimmed);

  // TeamId/channelId or already a conversation ID (19:xxx) — use directly
  if (!isUserTarget) {
    return cleaned;
  }

  // User:<aadId> — look up the conversation store for the real chat ID
  const store = createMSTeamsConversationStoreFs();
  const found = await store.findPreferredDmByUserId(cleaned);
  if (!found) {
    throw new Error(
      `No conversation found for user:${cleaned}. ` +
        "The bot must receive a message from this user before Graph API operations work.",
    );
  }

  // Prefer the cached Graph-native chat ID (19:xxx format) over the Bot Framework
  // Conversation ID, which may be in a non-Graph format (a:xxx / 8:orgid:xxx) for
  // Personal DMs. send-context.ts resolves and caches this on first send.
  if (found.reference.graphChatId) {
    return found.reference.graphChatId;
  }
  if (found.conversationId.startsWith("19:")) {
    return found.conversationId;
  }
  throw new Error(
    `Conversation for user:${cleaned} uses a Bot Framework ID (${found.conversationId}) ` +
      "that Graph API does not accept. Send a message to this user first so the Graph chat ID is cached.",
  );
}

function resolveConversationPath(to: string): {
  kind: "chat" | "channel";
  basePath: string;
  chatId?: string;
  teamId?: string;
  channelId?: string;
} {
  const cleaned = stripTargetPrefix(to);
  if (cleaned.includes("/")) {
    const [teamId, channelId] = cleaned.split("/", 2);
    return {
      basePath: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`,
      channelId,
      kind: "channel",
      teamId,
    };
  }
  return {
    basePath: `/chats/${encodeURIComponent(cleaned)}`,
    chatId: cleaned,
    kind: "chat",
  };
}

export interface GetMessageMSTeamsParams {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
}

export interface GetMessageMSTeamsResult {
  id: string;
  text: string | undefined;
  from: GraphMessageFrom | undefined;
  createdAt: string | undefined;
}

/**
 * Retrieve a single message by ID from a chat or channel via Graph API.
 */
export async function getMessageMSTeams(
  params: GetMessageMSTeamsParams,
): Promise<GetMessageMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const { basePath } = resolveConversationPath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}`;
  const msg = await fetchGraphJson<GraphMessage>({ path, token });
  return {
    createdAt: msg.createdDateTime,
    from: msg.from,
    id: msg.id ?? params.messageId,
    text: msg.body?.content,
  };
}

export interface PinMessageMSTeamsParams {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
}

/**
 * Pin a message in a chat conversation via Graph API.
 * Channel pinning uses a different endpoint (beta) handled separately.
 */
export async function pinMessageMSTeams(
  params: PinMessageMSTeamsParams,
): Promise<{ ok: true; pinnedMessageId?: string }> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const conv = resolveConversationPath(conversationId);

  if (conv.kind === "channel") {
    // Graph v1.0 doesn't have channel pin — use the pinnedMessages pattern on chat
    // For channels, attempt POST to pinnedMessages (same shape, may require beta)
    await postGraphJson<unknown>({
      body: { message: { id: params.messageId } },
      path: `${conv.basePath}/pinnedMessages`,
      token,
    });
    return { ok: true };
  }

  const result = await postGraphJson<{ id?: string }>({
    body: { message: { id: params.messageId } },
    path: `${conv.basePath}/pinnedMessages`,
    token,
  });
  return { ok: true, pinnedMessageId: result.id };
}

export interface UnpinMessageMSTeamsParams {
  cfg: OpenClawConfig;
  to: string;
  /** The pinned-message resource ID returned by pin or list-pins (not the message ID). */
  pinnedMessageId: string;
}

/**
 * Unpin a message in a chat conversation via Graph API.
 * `pinnedMessageId` is the pinned-message resource ID (from pin or list-pins),
 * not the underlying chat message ID.
 */
export async function unpinMessageMSTeams(
  params: UnpinMessageMSTeamsParams,
): Promise<{ ok: true }> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const conv = resolveConversationPath(conversationId);
  const path = `${conv.basePath}/pinnedMessages/${encodeURIComponent(params.pinnedMessageId)}`;
  await deleteGraphRequest({ path, token });
  return { ok: true };
}

export interface ListPinsMSTeamsParams {
  cfg: OpenClawConfig;
  to: string;
}

export interface ListPinsMSTeamsResult {
  pins: { id: string; pinnedMessageId: string; messageId?: string; text?: string }[];
}

/**
 * List all pinned messages in a chat conversation via Graph API.
 */
export async function listPinsMSTeams(
  params: ListPinsMSTeamsParams,
): Promise<ListPinsMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const conv = resolveConversationPath(conversationId);
  const path = `${conv.basePath}/pinnedMessages?$expand=message`;
  const res = await fetchGraphJson<GraphPinnedMessagesResponse>({ path, token });
  const pins = (res.value ?? []).map((pin) => ({
    id: pin.id ?? "",
    messageId: pin.message?.id,
    pinnedMessageId: pin.id ?? "",
    text: pin.message?.body?.content,
  }));
  return { pins };
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export const TEAMS_REACTION_TYPES = [
  "like",
  "heart",
  "laugh",
  "surprised",
  "sad",
  "angry",
] as const;
export type TeamsReactionType = (typeof TEAMS_REACTION_TYPES)[number];

interface GraphReaction {
  reactionType?: string;
  user?: { id?: string; displayName?: string };
  createdDateTime?: string;
}

type GraphMessageWithReactions = GraphMessage & {
  reactions?: GraphReaction[];
};

export interface ReactMessageMSTeamsParams {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
  reactionType: string;
}

export interface ListReactionsMSTeamsParams {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
}

export interface ReactionSummary {
  reactionType: string;
  count: number;
  users: { id: string; displayName?: string }[];
}

export interface ListReactionsMSTeamsResult {
  reactions: ReactionSummary[];
}

function validateReactionType(raw: string): TeamsReactionType {
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (!TEAMS_REACTION_TYPES.includes(normalized as TeamsReactionType)) {
    throw new Error(
      `Invalid reaction type "${raw}". Valid types: ${TEAMS_REACTION_TYPES.join(", ")}`,
    );
  }
  return normalized as TeamsReactionType;
}

/**
 * Add an emoji reaction to a message via Graph API (beta).
 */
export async function reactMessageMSTeams(
  params: ReactMessageMSTeamsParams,
): Promise<{ ok: true }> {
  const reactionType = validateReactionType(params.reactionType);
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const { basePath } = resolveConversationPath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}/setReaction`;
  await postGraphBetaJson<unknown>({ body: { reactionType }, path, token });
  return { ok: true };
}

/**
 * Remove an emoji reaction from a message via Graph API (beta).
 */
export async function unreactMessageMSTeams(
  params: ReactMessageMSTeamsParams,
): Promise<{ ok: true }> {
  const reactionType = validateReactionType(params.reactionType);
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const { basePath } = resolveConversationPath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}/unsetReaction`;
  await postGraphBetaJson<unknown>({ body: { reactionType }, path, token });
  return { ok: true };
}

/**
 * List reactions on a message, grouped by type.
 * Uses Graph v1.0 (reactions are included in the message resource).
 */
export async function listReactionsMSTeams(
  params: ListReactionsMSTeamsParams,
): Promise<ListReactionsMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const { basePath } = resolveConversationPath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}`;
  const msg = await fetchGraphJson<GraphMessageWithReactions>({ path, token });

  const grouped = new Map<string, { id: string; displayName?: string }[]>();
  for (const reaction of msg.reactions ?? []) {
    const type = reaction.reactionType ?? "unknown";
    if (!grouped.has(type)) {
      grouped.set(type, []);
    }
    if (reaction.user?.id) {
      grouped.get(type)!.push({
        displayName: reaction.user.displayName,
        id: reaction.user.id,
      });
    }
  }

  const reactions: ReactionSummary[] = [...grouped.entries()].map(([type, users]) => ({
    count: users.length,
    reactionType: type,
    users,
  }));

  return { reactions };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchMessagesMSTeamsParams {
  cfg: OpenClawConfig;
  to: string;
  query: string;
  from?: string;
  limit?: number;
}

export interface SearchMessagesMSTeamsResult {
  messages: {
    id: string;
    text: string | undefined;
    from: GraphMessageFrom | undefined;
    createdAt: string | undefined;
  }[];
}

const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 50;

/**
 * Search messages in a chat or channel by content via Graph API.
 * Uses `$search` for full-text body search and optional `$filter` for sender.
 */
export async function searchMessagesMSTeams(
  params: SearchMessagesMSTeamsParams,
): Promise<SearchMessagesMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const { basePath } = resolveConversationPath(conversationId);

  const rawLimit = params.limit ?? SEARCH_DEFAULT_LIMIT;
  const top = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), SEARCH_MAX_LIMIT)
    : SEARCH_DEFAULT_LIMIT;

  // Strip double quotes from the query to prevent OData $search injection
  const sanitizedQuery = params.query.replace(/"/g, "");

  // Build query string manually (not URLSearchParams) to preserve literal $
  // In OData parameter names, consistent with other Graph calls in this module.
  const parts = [`$search=${encodeURIComponent(`"${sanitizedQuery}"`)}`];
  parts.push(`$top=${top}`);
  if (params.from) {
    parts.push(
      `$filter=${encodeURIComponent(`from/user/displayName eq '${escapeOData(params.from)}'`)}`,
    );
  }

  const path = `${basePath}/messages?${parts.join("&")}`;
  // ConsistencyLevel: eventual is required by Graph API for $search queries
  const res = await fetchGraphJson<GraphResponse<GraphMessage>>({
    headers: { ConsistencyLevel: "eventual" },
    path,
    token,
  });

  const messages = (res.value ?? []).map((msg) => ({
    createdAt: msg.createdDateTime,
    from: msg.from,
    id: msg.id ?? "",
    text: msg.body?.content,
  }));

  return { messages };
}
