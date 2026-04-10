import type { RequestClient } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";

export class DiscordSendError extends Error {
  kind?: "missing-permissions" | "dm-blocked";
  channelId?: string;
  missingPermissions?: string[];

  constructor(message: string, opts?: Partial<DiscordSendError>) {
    super(message);
    this.name = "DiscordSendError";
    if (opts) {
      Object.assign(this, opts);
    }
  }

  override toString() {
    return this.message;
  }
}

export const DISCORD_MAX_EMOJI_BYTES = 256 * 1024;
export const DISCORD_MAX_STICKER_BYTES = 512 * 1024;
export const DISCORD_MAX_EVENT_COVER_BYTES = 8 * 1024 * 1024;

export interface DiscordSendResult {
  messageId: string;
  channelId: string;
}

export interface DiscordRuntimeAccountContext {
  cfg: OpenClawConfig;
  accountId: string;
}

export interface DiscordReactOpts {
  cfg?: OpenClawConfig;
  accountId?: string;
  token?: string;
  rest?: RequestClient;
  verbose?: boolean;
  retry?: RetryConfig;
}

export type DiscordReactionRuntimeContext = DiscordRuntimeAccountContext & {
  rest: RequestClient;
};

export interface DiscordReactionUser {
  id: string;
  username?: string;
  tag?: string;
}

export interface DiscordReactionSummary {
  emoji: { id?: string | null; name?: string | null; raw: string };
  count: number;
  users: DiscordReactionUser[];
}

export interface DiscordPermissionsSummary {
  channelId: string;
  guildId?: string;
  permissions: string[];
  raw: string;
  isDm: boolean;
  channelType?: number;
}

export interface DiscordMessageQuery {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
}

export interface DiscordMessageEdit {
  content?: string;
}

export interface DiscordThreadCreate {
  messageId?: string;
  name: string;
  autoArchiveMinutes?: number;
  content?: string;
  /** Discord thread type (default: PublicThread for standalone threads). */
  type?: number;
  /** Tag IDs to apply when creating a forum/media thread (Discord `applied_tags`). */
  appliedTags?: string[];
}

export interface DiscordThreadList {
  guildId: string;
  channelId?: string;
  includeArchived?: boolean;
  before?: string;
  limit?: number;
}

export interface DiscordSearchQuery {
  guildId: string;
  content: string;
  channelIds?: string[];
  authorIds?: string[];
  limit?: number;
}

export interface DiscordRoleChange {
  guildId: string;
  userId: string;
  roleId: string;
}

export interface DiscordModerationTarget {
  guildId: string;
  userId: string;
  reason?: string;
}

export type DiscordTimeoutTarget = DiscordModerationTarget & {
  until?: string;
  durationMinutes?: number;
};

export interface DiscordEmojiUpload {
  guildId: string;
  name: string;
  mediaUrl: string;
  roleIds?: string[];
}

export interface DiscordStickerUpload {
  guildId: string;
  name: string;
  description: string;
  tags: string;
  mediaUrl: string;
}

export interface DiscordChannelCreate {
  guildId: string;
  name: string;
  type?: number;
  parentId?: string;
  topic?: string;
  position?: number;
  nsfw?: boolean;
}

export interface DiscordForumTag {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
}

export interface DiscordChannelEdit {
  channelId: string;
  name?: string;
  topic?: string;
  position?: number;
  parentId?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  archived?: boolean;
  locked?: boolean;
  autoArchiveDuration?: number;
  availableTags?: DiscordForumTag[];
}

export interface DiscordChannelMove {
  guildId: string;
  channelId: string;
  parentId?: string | null;
  position?: number;
}

export interface DiscordChannelPermissionSet {
  channelId: string;
  targetId: string;
  targetType: 0 | 1;
  allow?: string;
  deny?: string;
}
