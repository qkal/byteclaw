import { PermissionFlagsBits } from "discord-api-types/v10";
import { readNumberParam, readStringParam } from "../runtime-api.js";

export type DiscordModerationAction = "timeout" | "kick" | "ban";

export interface DiscordModerationCommand {
  action: DiscordModerationAction;
  guildId: string;
  userId: string;
  durationMinutes?: number;
  until?: string;
  reason?: string;
  deleteMessageDays?: number;
}

const moderationPermissions: Record<DiscordModerationAction, bigint> = {
  ban: PermissionFlagsBits.BanMembers,
  kick: PermissionFlagsBits.KickMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
};

export function isDiscordModerationAction(action: string): action is DiscordModerationAction {
  return action === "timeout" || action === "kick" || action === "ban";
}

export function requiredGuildPermissionForModerationAction(
  action: DiscordModerationAction,
): bigint {
  return moderationPermissions[action];
}

export function readDiscordModerationCommand(
  action: string,
  params: Record<string, unknown>,
): DiscordModerationCommand {
  if (!isDiscordModerationAction(action)) {
    throw new Error(`Unsupported Discord moderation action: ${action}`);
  }
  return {
    action,
    deleteMessageDays: readNumberParam(params, "deleteMessageDays", { integer: true }),
    durationMinutes: readNumberParam(params, "durationMinutes", { integer: true }),
    guildId: readStringParam(params, "guildId", { required: true }),
    reason: readStringParam(params, "reason"),
    until: readStringParam(params, "until"),
    userId: readStringParam(params, "userId", { required: true }),
  };
}
