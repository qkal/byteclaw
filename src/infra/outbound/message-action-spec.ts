import { getBootstrapChannelPlugin } from "../../channels/plugins/bootstrap-registry.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export type MessageActionTargetMode = "to" | "channelId" | "none";

export const MESSAGE_ACTION_TARGET_MODE: Record<ChannelMessageActionName, MessageActionTargetMode> =
  {
    addParticipant: "to",
    ban: "none",
    broadcast: "none",
    "category-create": "none",
    "category-delete": "none",
    "category-edit": "none",
    "channel-create": "none",
    "channel-delete": "channelId",
    "channel-edit": "channelId",
    "channel-info": "channelId",
    "channel-list": "none",
    "channel-move": "channelId",
    delete: "to",
    "download-file": "none",
    edit: "to",
    "emoji-list": "none",
    "emoji-upload": "none",
    "event-create": "none",
    "event-list": "none",
    kick: "none",
    leaveGroup: "to",
    "list-pins": "to",
    "member-info": "none",
    permissions: "to",
    pin: "to",
    poll: "to",
    "poll-vote": "to",
    react: "to",
    reactions: "to",
    read: "to",
    removeParticipant: "to",
    renameGroup: "to",
    reply: "to",
    "role-add": "none",
    "role-info": "none",
    "role-remove": "none",
    search: "none",
    send: "to",
    sendAttachment: "to",
    sendWithEffect: "to",
    "set-presence": "none",
    "set-profile": "none",
    setGroupIcon: "to",
    sticker: "to",
    "sticker-search": "none",
    "sticker-upload": "none",
    "thread-create": "to",
    "thread-list": "none",
    "thread-reply": "to",
    timeout: "none",
    "topic-create": "to",
    "topic-edit": "to",
    unpin: "to",
    unsend: "to",
    "upload-file": "to",
    "voice-status": "none",
  };

interface ActionTargetAliasSpec {
  aliases: string[];
}

const ACTION_TARGET_ALIASES: Partial<Record<ChannelMessageActionName, ActionTargetAliasSpec>> = {
  addParticipant: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  edit: { aliases: ["messageId"] },
  leaveGroup: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  react: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  removeParticipant: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  renameGroup: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  setGroupIcon: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  unsend: { aliases: ["messageId"] },
};

function listActionTargetAliasSpecs(
  action: ChannelMessageActionName,
  channel?: string,
): ActionTargetAliasSpec[] {
  const specs: ActionTargetAliasSpec[] = [];
  const coreSpec = ACTION_TARGET_ALIASES[action];
  if (coreSpec) {
    specs.push(coreSpec);
  }
  const normalizedChannel = normalizeOptionalLowercaseString(channel);
  if (!normalizedChannel) {
    return specs;
  }
  const plugin = getBootstrapChannelPlugin(normalizedChannel);
  const channelSpec = plugin?.actions?.messageActionTargetAliases?.[action];
  if (channelSpec) {
    specs.push(channelSpec);
  }
  return specs;
}

export function actionRequiresTarget(action: ChannelMessageActionName): boolean {
  return MESSAGE_ACTION_TARGET_MODE[action] !== "none";
}

export function actionHasTarget(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  options?: { channel?: string },
): boolean {
  const to = normalizeOptionalString(params.to) ?? "";
  if (to) {
    return true;
  }
  const channelId = normalizeOptionalString(params.channelId) ?? "";
  if (channelId) {
    return true;
  }
  const specs = listActionTargetAliasSpecs(action, options?.channel);
  if (specs.length === 0) {
    return false;
  }
  return specs.some((spec) =>
    spec.aliases.some((alias) => {
      const value = params[alias];
      if (typeof value === "string") {
        return Boolean(normalizeOptionalString(value));
      }
      if (typeof value === "number") {
        return Number.isFinite(value);
      }
      return false;
    }),
  );
}
