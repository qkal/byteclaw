import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  parseAvailableTags,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/agent-runtime";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { handleDiscordAction } from "../../action-runtime-api.js";
import {
  isDiscordModerationAction,
  readDiscordModerationCommand,
} from "./runtime.moderation-shared.js";

type Ctx = Pick<
  ChannelMessageActionContext,
  "action" | "params" | "cfg" | "accountId" | "requesterSenderId" | "mediaLocalRoots"
>;

export async function tryHandleDiscordMessageActionGuildAdmin(params: {
  ctx: Ctx;
  resolveChannelId: () => string;
  readParentIdParam: (params: Record<string, unknown>) => string | null | undefined;
}): Promise<AgentToolResult<unknown> | undefined> {
  const { ctx, resolveChannelId, readParentIdParam } = params;
  const { action, params: actionParams, cfg } = ctx;
  const accountId = ctx.accountId ?? readStringParam(actionParams, "accountId");

  if (action === "member-info") {
    const userId = readStringParam(actionParams, "userId", { required: true });
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    return await handleDiscordAction(
      { accountId: accountId ?? undefined, action: "memberInfo", guildId, userId },
      cfg,
    );
  }

  if (action === "role-info") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    return await handleDiscordAction(
      { accountId: accountId ?? undefined, action: "roleInfo", guildId },
      cfg,
    );
  }

  if (action === "emoji-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    return await handleDiscordAction(
      { accountId: accountId ?? undefined, action: "emojiList", guildId },
      cfg,
    );
  }

  if (action === "emoji-upload") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const name = readStringParam(actionParams, "emojiName", { required: true });
    const mediaUrl = readStringParam(actionParams, "media", {
      required: true,
      trim: false,
    });
    const roleIds = readStringArrayParam(actionParams, "roleIds");
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "emojiUpload",
        guildId,
        mediaUrl,
        name,
        roleIds,
      },
      cfg,
    );
  }

  if (action === "sticker-upload") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const name = readStringParam(actionParams, "stickerName", {
      required: true,
    });
    const description = readStringParam(actionParams, "stickerDesc", {
      required: true,
    });
    const tags = readStringParam(actionParams, "stickerTags", {
      required: true,
    });
    const mediaUrl = readStringParam(actionParams, "media", {
      required: true,
      trim: false,
    });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "stickerUpload",
        description,
        guildId,
        mediaUrl,
        name,
        tags,
      },
      cfg,
    );
  }

  if (action === "role-add" || action === "role-remove") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const userId = readStringParam(actionParams, "userId", { required: true });
    const roleId = readStringParam(actionParams, "roleId", { required: true });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: action === "role-add" ? "roleAdd" : "roleRemove",
        guildId,
        roleId,
        userId,
      },
      cfg,
    );
  }

  if (action === "channel-info") {
    const channelId = readStringParam(actionParams, "channelId", {
      required: true,
    });
    return await handleDiscordAction(
      { accountId: accountId ?? undefined, action: "channelInfo", channelId },
      cfg,
    );
  }

  if (action === "channel-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    return await handleDiscordAction(
      { accountId: accountId ?? undefined, action: "channelList", guildId },
      cfg,
    );
  }

  if (action === "channel-create") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const name = readStringParam(actionParams, "name", { required: true });
    const type = readNumberParam(actionParams, "type", { integer: true });
    const parentId = readParentIdParam(actionParams);
    const topic = readStringParam(actionParams, "topic");
    const position = readNumberParam(actionParams, "position", {
      integer: true,
    });
    const nsfw = typeof actionParams.nsfw === "boolean" ? actionParams.nsfw : undefined;
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "channelCreate",
        guildId,
        name,
        nsfw,
        parentId: parentId ?? undefined,
        position: position ?? undefined,
        topic: topic ?? undefined,
        type: type ?? undefined,
      },
      cfg,
    );
  }

  if (action === "channel-edit") {
    const channelId = readStringParam(actionParams, "channelId", {
      required: true,
    });
    const name = readStringParam(actionParams, "name");
    const topic = readStringParam(actionParams, "topic");
    const position = readNumberParam(actionParams, "position", {
      integer: true,
    });
    const parentId = readParentIdParam(actionParams);
    const nsfw = typeof actionParams.nsfw === "boolean" ? actionParams.nsfw : undefined;
    const rateLimitPerUser = readNumberParam(actionParams, "rateLimitPerUser", {
      integer: true,
    });
    const archived = typeof actionParams.archived === "boolean" ? actionParams.archived : undefined;
    const locked = typeof actionParams.locked === "boolean" ? actionParams.locked : undefined;
    const autoArchiveDuration = readNumberParam(actionParams, "autoArchiveDuration", {
      integer: true,
    });
    const availableTags = parseAvailableTags(actionParams.availableTags);
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "channelEdit",
        archived,
        autoArchiveDuration: autoArchiveDuration ?? undefined,
        availableTags,
        channelId,
        locked,
        name: name ?? undefined,
        nsfw,
        parentId: parentId === undefined ? undefined : parentId,
        position: position ?? undefined,
        rateLimitPerUser: rateLimitPerUser ?? undefined,
        topic: topic ?? undefined,
      },
      cfg,
    );
  }

  if (action === "channel-delete") {
    const channelId = readStringParam(actionParams, "channelId", {
      required: true,
    });
    return await handleDiscordAction(
      { accountId: accountId ?? undefined, action: "channelDelete", channelId },
      cfg,
    );
  }

  if (action === "channel-move") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const channelId = readStringParam(actionParams, "channelId", {
      required: true,
    });
    const parentId = readParentIdParam(actionParams);
    const position = readNumberParam(actionParams, "position", {
      integer: true,
    });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "channelMove",
        channelId,
        guildId,
        parentId: parentId === undefined ? undefined : parentId,
        position: position ?? undefined,
      },
      cfg,
    );
  }

  if (action === "category-create") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const name = readStringParam(actionParams, "name", { required: true });
    const position = readNumberParam(actionParams, "position", {
      integer: true,
    });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "categoryCreate",
        guildId,
        name,
        position: position ?? undefined,
      },
      cfg,
    );
  }

  if (action === "category-edit") {
    const categoryId = readStringParam(actionParams, "categoryId", {
      required: true,
    });
    const name = readStringParam(actionParams, "name");
    const position = readNumberParam(actionParams, "position", {
      integer: true,
    });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "categoryEdit",
        categoryId,
        name: name ?? undefined,
        position: position ?? undefined,
      },
      cfg,
    );
  }

  if (action === "category-delete") {
    const categoryId = readStringParam(actionParams, "categoryId", {
      required: true,
    });
    return await handleDiscordAction(
      { accountId: accountId ?? undefined, action: "categoryDelete", categoryId },
      cfg,
    );
  }

  if (action === "voice-status") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const userId = readStringParam(actionParams, "userId", { required: true });
    return await handleDiscordAction(
      { accountId: accountId ?? undefined, action: "voiceStatus", guildId, userId },
      cfg,
    );
  }

  if (action === "event-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    return await handleDiscordAction(
      { accountId: accountId ?? undefined, action: "eventList", guildId },
      cfg,
    );
  }

  if (action === "event-create") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const name = readStringParam(actionParams, "eventName", { required: true });
    const startTime = readStringParam(actionParams, "startTime", {
      required: true,
    });
    const endTime = readStringParam(actionParams, "endTime");
    const description = readStringParam(actionParams, "desc");
    const channelId = readStringParam(actionParams, "channelId");
    const location = readStringParam(actionParams, "location");
    const entityType = readStringParam(actionParams, "eventType");
    const image = readStringParam(actionParams, "image", { trim: false });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "eventCreate",
        channelId,
        description,
        endTime,
        entityType,
        guildId,
        image,
        location,
        name,
        startTime,
      },
      cfg,
      { mediaLocalRoots: ctx.mediaLocalRoots },
    );
  }

  if (isDiscordModerationAction(action)) {
    const moderation = readDiscordModerationCommand(action, {
      ...actionParams,
      deleteMessageDays: readNumberParam(actionParams, "deleteDays", {
        integer: true,
      }),
      durationMinutes: readNumberParam(actionParams, "durationMin", { integer: true }),
    });
    const senderUserId = normalizeOptionalString(ctx.requesterSenderId);
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: moderation.action,
        deleteMessageDays: moderation.deleteMessageDays,
        durationMinutes: moderation.durationMinutes,
        guildId: moderation.guildId,
        reason: moderation.reason,
        senderUserId,
        until: moderation.until,
        userId: moderation.userId,
      },
      cfg,
    );
  }

  // Some actions are conceptually "admin", but still act on a resolved channel.
  if (action === "thread-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const channelId = readStringParam(actionParams, "channelId");
    const includeArchived =
      typeof actionParams.includeArchived === "boolean" ? actionParams.includeArchived : undefined;
    const before = readStringParam(actionParams, "before");
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "threadList",
        before,
        channelId,
        guildId,
        includeArchived,
        limit,
      },
      cfg,
    );
  }

  if (action === "thread-reply") {
    const content = readStringParam(actionParams, "message", {
      required: true,
    });
    const mediaUrl = readStringParam(actionParams, "media", { trim: false });
    const replyTo = readStringParam(actionParams, "replyTo");

    // `message.thread-reply` (tool) uses `threadId`, while the CLI historically used `to`/`channelId`.
    // Prefer `threadId` when present to avoid accidentally replying in the parent channel.
    const threadId = readStringParam(actionParams, "threadId");
    const channelId = threadId ?? resolveChannelId();

    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "threadReply",
        channelId,
        content,
        mediaUrl: mediaUrl ?? undefined,
        replyTo: replyTo ?? undefined,
      },
      cfg,
    );
  }

  if (action === "search") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true,
    });
    const query = readStringParam(actionParams, "query", { required: true });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "searchMessages",
        authorId: readStringParam(actionParams, "authorId"),
        authorIds: readStringArrayParam(actionParams, "authorIds"),
        channelId: readStringParam(actionParams, "channelId"),
        channelIds: readStringArrayParam(actionParams, "channelIds"),
        content: query,
        guildId,
        limit: readNumberParam(actionParams, "limit", { integer: true }),
      },
      cfg,
    );
  }

  return undefined;
}
