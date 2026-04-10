import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveDefaultDiscordAccountId } from "../accounts.js";
import { getPresence } from "../monitor/presence-cache.js";
import {
  type ActionGate,
  type DiscordActionConfig,
  type OpenClawConfig,
  jsonResult,
  parseAvailableTags,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../runtime-api.js";
import {
  addRoleDiscord,
  createChannelDiscord,
  createScheduledEventDiscord,
  deleteChannelDiscord,
  editChannelDiscord,
  fetchChannelInfoDiscord,
  fetchMemberInfoDiscord,
  fetchRoleInfoDiscord,
  fetchVoiceStatusDiscord,
  listGuildChannelsDiscord,
  listGuildEmojisDiscord,
  listScheduledEventsDiscord,
  moveChannelDiscord,
  removeChannelPermissionDiscord,
  removeRoleDiscord,
  resolveEventCoverImage,
  setChannelPermissionDiscord,
  uploadEmojiDiscord,
  uploadStickerDiscord,
} from "../send.js";
import { readDiscordParentIdParam } from "./runtime.shared.js";

export const discordGuildActionRuntime = {
  addRoleDiscord,
  createChannelDiscord,
  createScheduledEventDiscord,
  deleteChannelDiscord,
  editChannelDiscord,
  fetchChannelInfoDiscord,
  fetchMemberInfoDiscord,
  fetchRoleInfoDiscord,
  fetchVoiceStatusDiscord,
  listGuildChannelsDiscord,
  listGuildEmojisDiscord,
  listScheduledEventsDiscord,
  moveChannelDiscord,
  removeChannelPermissionDiscord,
  removeRoleDiscord,
  resolveEventCoverImage,
  setChannelPermissionDiscord,
  uploadEmojiDiscord,
  uploadStickerDiscord,
};

type DiscordRoleMutation = (params: {
  guildId: string;
  userId: string;
  roleId: string;
}) => Promise<unknown>;
type DiscordRoleMutationWithAccount = (
  params: {
    guildId: string;
    userId: string;
    roleId: string;
  },
  options: { accountId: string },
) => Promise<unknown>;

async function runRoleMutation(params: {
  accountId?: string;
  values: Record<string, unknown>;
  mutate: DiscordRoleMutation & DiscordRoleMutationWithAccount;
}) {
  const guildId = readStringParam(params.values, "guildId", { required: true });
  const userId = readStringParam(params.values, "userId", { required: true });
  const roleId = readStringParam(params.values, "roleId", { required: true });
  if (params.accountId) {
    await params.mutate({ guildId, roleId, userId }, { accountId: params.accountId });
    return;
  }
  await params.mutate({ guildId, roleId, userId });
}

function readChannelPermissionTarget(params: Record<string, unknown>) {
  return {
    channelId: readStringParam(params, "channelId", { required: true }),
    targetId: readStringParam(params, "targetId", { required: true }),
  };
}

export async function handleDiscordGuildAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
  cfg?: OpenClawConfig,
  options?: { mediaLocalRoots?: readonly string[] },
): Promise<AgentToolResult<unknown>> {
  const accountId = readStringParam(params, "accountId");
  switch (action) {
    case "memberInfo": {
      if (!isActionEnabled("memberInfo")) {
        throw new Error("Discord member info is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", {
        required: true,
      });
      const effectiveAccountId =
        accountId ?? (cfg ? resolveDefaultDiscordAccountId(cfg) : undefined);
      const member = effectiveAccountId
        ? await discordGuildActionRuntime.fetchMemberInfoDiscord(guildId, userId, {
            accountId: effectiveAccountId,
          })
        : await discordGuildActionRuntime.fetchMemberInfoDiscord(guildId, userId);
      const presence = getPresence(effectiveAccountId, userId);
      const activities = presence?.activities ?? undefined;
      const status = presence?.status ?? undefined;
      return jsonResult({ member, ok: true, ...(presence ? { activities, status } : {}) });
    }
    case "roleInfo": {
      if (!isActionEnabled("roleInfo")) {
        throw new Error("Discord role info is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const roles = accountId
        ? await discordGuildActionRuntime.fetchRoleInfoDiscord(guildId, { accountId })
        : await discordGuildActionRuntime.fetchRoleInfoDiscord(guildId);
      return jsonResult({ ok: true, roles });
    }
    case "emojiList": {
      if (!isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const emojis = accountId
        ? await discordGuildActionRuntime.listGuildEmojisDiscord(guildId, { accountId })
        : await discordGuildActionRuntime.listGuildEmojisDiscord(guildId);
      return jsonResult({ emojis, ok: true });
    }
    case "emojiUpload": {
      if (!isActionEnabled("emojiUploads")) {
        throw new Error("Discord emoji uploads are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const name = readStringParam(params, "name", { required: true });
      const mediaUrl = readStringParam(params, "mediaUrl", {
        required: true,
      });
      const roleIds = readStringArrayParam(params, "roleIds");
      const emoji = accountId
        ? await discordGuildActionRuntime.uploadEmojiDiscord(
            {
              guildId,
              mediaUrl,
              name,
              roleIds: roleIds?.length ? roleIds : undefined,
            },
            { accountId },
          )
        : await discordGuildActionRuntime.uploadEmojiDiscord({
            guildId,
            mediaUrl,
            name,
            roleIds: roleIds?.length ? roleIds : undefined,
          });
      return jsonResult({ emoji, ok: true });
    }
    case "stickerUpload": {
      if (!isActionEnabled("stickerUploads")) {
        throw new Error("Discord sticker uploads are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const name = readStringParam(params, "name", { required: true });
      const description = readStringParam(params, "description", {
        required: true,
      });
      const tags = readStringParam(params, "tags", { required: true });
      const mediaUrl = readStringParam(params, "mediaUrl", {
        required: true,
      });
      const sticker = accountId
        ? await discordGuildActionRuntime.uploadStickerDiscord(
            {
              description,
              guildId,
              mediaUrl,
              name,
              tags,
            },
            { accountId },
          )
        : await discordGuildActionRuntime.uploadStickerDiscord({
            description,
            guildId,
            mediaUrl,
            name,
            tags,
          });
      return jsonResult({ ok: true, sticker });
    }
    case "roleAdd": {
      if (!isActionEnabled("roles", false)) {
        throw new Error("Discord role changes are disabled.");
      }
      await runRoleMutation({
        accountId,
        mutate: discordGuildActionRuntime.addRoleDiscord,
        values: params,
      });
      return jsonResult({ ok: true });
    }
    case "roleRemove": {
      if (!isActionEnabled("roles", false)) {
        throw new Error("Discord role changes are disabled.");
      }
      await runRoleMutation({
        accountId,
        mutate: discordGuildActionRuntime.removeRoleDiscord,
        values: params,
      });
      return jsonResult({ ok: true });
    }
    case "channelInfo": {
      if (!isActionEnabled("channelInfo")) {
        throw new Error("Discord channel info is disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const channel = accountId
        ? await discordGuildActionRuntime.fetchChannelInfoDiscord(channelId, { accountId })
        : await discordGuildActionRuntime.fetchChannelInfoDiscord(channelId);
      return jsonResult({ channel, ok: true });
    }
    case "channelList": {
      if (!isActionEnabled("channelInfo")) {
        throw new Error("Discord channel info is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const channels = accountId
        ? await discordGuildActionRuntime.listGuildChannelsDiscord(guildId, { accountId })
        : await discordGuildActionRuntime.listGuildChannelsDiscord(guildId);
      return jsonResult({ channels, ok: true });
    }
    case "voiceStatus": {
      if (!isActionEnabled("voiceStatus")) {
        throw new Error("Discord voice status is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", {
        required: true,
      });
      const voice = accountId
        ? await discordGuildActionRuntime.fetchVoiceStatusDiscord(guildId, userId, {
            accountId,
          })
        : await discordGuildActionRuntime.fetchVoiceStatusDiscord(guildId, userId);
      return jsonResult({ ok: true, voice });
    }
    case "eventList": {
      if (!isActionEnabled("events")) {
        throw new Error("Discord events are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const events = accountId
        ? await discordGuildActionRuntime.listScheduledEventsDiscord(guildId, { accountId })
        : await discordGuildActionRuntime.listScheduledEventsDiscord(guildId);
      return jsonResult({ events, ok: true });
    }
    case "eventCreate": {
      if (!isActionEnabled("events")) {
        throw new Error("Discord events are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const name = readStringParam(params, "name", { required: true });
      const startTime = readStringParam(params, "startTime", {
        required: true,
      });
      const endTime = readStringParam(params, "endTime");
      const description = readStringParam(params, "description");
      const channelId = readStringParam(params, "channelId");
      const location = readStringParam(params, "location");
      const imageUrl = readStringParam(params, "image", { trim: false });
      const entityTypeRaw = readStringParam(params, "entityType");
      const entityType = entityTypeRaw === "stage" ? 1 : entityTypeRaw === "external" ? 3 : 2;
      const image = imageUrl
        ? await discordGuildActionRuntime.resolveEventCoverImage(imageUrl, {
            localRoots: options?.mediaLocalRoots,
          })
        : undefined;
      const payload = {
        channel_id: channelId,
        description,
        entity_metadata: entityType === 3 && location ? { location } : undefined,
        entity_type: entityType,
        image,
        name,
        privacy_level: 2,
        scheduled_end_time: endTime,
        scheduled_start_time: startTime,
      };
      const event = accountId
        ? await discordGuildActionRuntime.createScheduledEventDiscord(guildId, payload, {
            accountId,
          })
        : await discordGuildActionRuntime.createScheduledEventDiscord(guildId, payload);
      return jsonResult({ event, ok: true });
    }
    case "channelCreate": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const type = readNumberParam(params, "type", { integer: true });
      const parentId = readDiscordParentIdParam(params);
      const topic = readStringParam(params, "topic");
      const position = readNumberParam(params, "position", { integer: true });
      const nsfw = params.nsfw as boolean | undefined;
      const channel = accountId
        ? await discordGuildActionRuntime.createChannelDiscord(
            {
              guildId,
              name,
              nsfw,
              parentId: parentId ?? undefined,
              position: position ?? undefined,
              topic: topic ?? undefined,
              type: type ?? undefined,
            },
            { accountId },
          )
        : await discordGuildActionRuntime.createChannelDiscord({
            guildId,
            name,
            nsfw,
            parentId: parentId ?? undefined,
            position: position ?? undefined,
            topic: topic ?? undefined,
            type: type ?? undefined,
          });
      return jsonResult({ channel, ok: true });
    }
    case "channelEdit": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const name = readStringParam(params, "name");
      const topic = readStringParam(params, "topic");
      const position = readNumberParam(params, "position", { integer: true });
      const parentId = readDiscordParentIdParam(params);
      const nsfw = params.nsfw as boolean | undefined;
      const rateLimitPerUser = readNumberParam(params, "rateLimitPerUser", {
        integer: true,
      });
      const archived = typeof params.archived === "boolean" ? params.archived : undefined;
      const locked = typeof params.locked === "boolean" ? params.locked : undefined;
      const autoArchiveDuration = readNumberParam(params, "autoArchiveDuration", {
        integer: true,
      });
      const availableTags = parseAvailableTags(params.availableTags);
      const editPayload = {
        archived,
        autoArchiveDuration: autoArchiveDuration ?? undefined,
        availableTags,
        channelId,
        locked,
        name: name ?? undefined,
        nsfw,
        parentId,
        position: position ?? undefined,
        rateLimitPerUser: rateLimitPerUser ?? undefined,
        topic: topic ?? undefined,
      };
      const channel = accountId
        ? await discordGuildActionRuntime.editChannelDiscord(editPayload, { accountId })
        : await discordGuildActionRuntime.editChannelDiscord(editPayload);
      return jsonResult({ channel, ok: true });
    }
    case "channelDelete": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const result = accountId
        ? await discordGuildActionRuntime.deleteChannelDiscord(channelId, { accountId })
        : await discordGuildActionRuntime.deleteChannelDiscord(channelId);
      return jsonResult(result);
    }
    case "channelMove": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const parentId = readDiscordParentIdParam(params);
      const position = readNumberParam(params, "position", { integer: true });
      if (accountId) {
        await discordGuildActionRuntime.moveChannelDiscord(
          {
            channelId,
            guildId,
            parentId,
            position: position ?? undefined,
          },
          { accountId },
        );
      } else {
        await discordGuildActionRuntime.moveChannelDiscord({
          channelId,
          guildId,
          parentId,
          position: position ?? undefined,
        });
      }
      return jsonResult({ ok: true });
    }
    case "categoryCreate": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const position = readNumberParam(params, "position", { integer: true });
      const channel = accountId
        ? await discordGuildActionRuntime.createChannelDiscord(
            {
              guildId,
              name,
              position: position ?? undefined,
              type: 4,
            },
            { accountId },
          )
        : await discordGuildActionRuntime.createChannelDiscord({
            guildId,
            name,
            position: position ?? undefined,
            type: 4,
          });
      return jsonResult({ category: channel, ok: true });
    }
    case "categoryEdit": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const categoryId = readStringParam(params, "categoryId", {
        required: true,
      });
      const name = readStringParam(params, "name");
      const position = readNumberParam(params, "position", { integer: true });
      const channel = accountId
        ? await discordGuildActionRuntime.editChannelDiscord(
            {
              channelId: categoryId,
              name: name ?? undefined,
              position: position ?? undefined,
            },
            { accountId },
          )
        : await discordGuildActionRuntime.editChannelDiscord({
            channelId: categoryId,
            name: name ?? undefined,
            position: position ?? undefined,
          });
      return jsonResult({ category: channel, ok: true });
    }
    case "categoryDelete": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const categoryId = readStringParam(params, "categoryId", {
        required: true,
      });
      const result = accountId
        ? await discordGuildActionRuntime.deleteChannelDiscord(categoryId, { accountId })
        : await discordGuildActionRuntime.deleteChannelDiscord(categoryId);
      return jsonResult(result);
    }
    case "channelPermissionSet": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const { channelId, targetId } = readChannelPermissionTarget(params);
      const targetTypeRaw = readStringParam(params, "targetType", {
        required: true,
      });
      const targetType = targetTypeRaw === "member" ? 1 : 0;
      const allow = readStringParam(params, "allow");
      const deny = readStringParam(params, "deny");
      if (accountId) {
        await discordGuildActionRuntime.setChannelPermissionDiscord(
          {
            allow: allow ?? undefined,
            channelId,
            deny: deny ?? undefined,
            targetId,
            targetType,
          },
          { accountId },
        );
      } else {
        await discordGuildActionRuntime.setChannelPermissionDiscord({
          allow: allow ?? undefined,
          channelId,
          deny: deny ?? undefined,
          targetId,
          targetType,
        });
      }
      return jsonResult({ ok: true });
    }
    case "channelPermissionRemove": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const { channelId, targetId } = readChannelPermissionTarget(params);
      if (accountId) {
        await discordGuildActionRuntime.removeChannelPermissionDiscord(channelId, targetId, {
          accountId,
        });
      } else {
        await discordGuildActionRuntime.removeChannelPermissionDiscord(channelId, targetId);
      }
      return jsonResult({ ok: true });
    }
    default: {
      throw new Error(`Unknown action: ${action}`);
    }
  }
}
