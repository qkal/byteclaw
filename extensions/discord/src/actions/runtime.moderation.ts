import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type ActionGate,
  type DiscordActionConfig,
  jsonResult,
  readStringParam,
} from "../runtime-api.js";
import {
  banMemberDiscord,
  hasAnyGuildPermissionDiscord,
  kickMemberDiscord,
  timeoutMemberDiscord,
} from "../send.js";
import {
  isDiscordModerationAction,
  readDiscordModerationCommand,
  requiredGuildPermissionForModerationAction,
} from "./runtime.moderation-shared.js";

export const discordModerationActionRuntime = {
  banMemberDiscord,
  hasAnyGuildPermissionDiscord,
  kickMemberDiscord,
  timeoutMemberDiscord,
};

async function verifySenderModerationPermission(params: {
  guildId: string;
  senderUserId?: string;
  requiredPermission: bigint;
  accountId?: string;
}) {
  // CLI/manual flows may not have sender context; enforce only when present.
  if (!params.senderUserId) {
    return;
  }
  const hasPermission = await discordModerationActionRuntime.hasAnyGuildPermissionDiscord(
    params.guildId,
    params.senderUserId,
    [params.requiredPermission],
    params.accountId ? { accountId: params.accountId } : undefined,
  );
  if (!hasPermission) {
    throw new Error("Sender does not have required permissions for this moderation action.");
  }
}

export async function handleDiscordModerationAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
): Promise<AgentToolResult<unknown>> {
  if (!isDiscordModerationAction(action)) {
    throw new Error(`Unknown action: ${action}`);
  }
  if (!isActionEnabled("moderation", false)) {
    throw new Error("Discord moderation is disabled.");
  }
  const command = readDiscordModerationCommand(action, params);
  const accountId = readStringParam(params, "accountId");
  const senderUserId = readStringParam(params, "senderUserId");
  await verifySenderModerationPermission({
    accountId,
    guildId: command.guildId,
    requiredPermission: requiredGuildPermissionForModerationAction(command.action),
    senderUserId,
  });
  switch (command.action) {
    case "timeout": {
      const member = accountId
        ? await discordModerationActionRuntime.timeoutMemberDiscord(
            {
              durationMinutes: command.durationMinutes,
              guildId: command.guildId,
              reason: command.reason,
              until: command.until,
              userId: command.userId,
            },
            { accountId },
          )
        : await discordModerationActionRuntime.timeoutMemberDiscord({
            durationMinutes: command.durationMinutes,
            guildId: command.guildId,
            reason: command.reason,
            until: command.until,
            userId: command.userId,
          });
      return jsonResult({ member, ok: true });
    }
    case "kick": {
      if (accountId) {
        await discordModerationActionRuntime.kickMemberDiscord(
          {
            guildId: command.guildId,
            reason: command.reason,
            userId: command.userId,
          },
          { accountId },
        );
      } else {
        await discordModerationActionRuntime.kickMemberDiscord({
          guildId: command.guildId,
          reason: command.reason,
          userId: command.userId,
        });
      }
      return jsonResult({ ok: true });
    }
    case "ban": {
      if (accountId) {
        await discordModerationActionRuntime.banMemberDiscord(
          {
            deleteMessageDays: command.deleteMessageDays,
            guildId: command.guildId,
            reason: command.reason,
            userId: command.userId,
          },
          { accountId },
        );
      } else {
        await discordModerationActionRuntime.banMemberDiscord({
          deleteMessageDays: command.deleteMessageDays,
          guildId: command.guildId,
          reason: command.reason,
          userId: command.userId,
        });
      }
      return jsonResult({ ok: true });
    }
  }
}
