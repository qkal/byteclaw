/**
 * Plugin Command Handler
 *
 * Handles commands registered by plugins, bypassing the LLM agent.
 * This handler is called before built-in command handlers.
 */

import { executePluginCommand, matchPluginCommand } from "../../plugins/commands.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

/**
 * Handle plugin-registered commands.
 * Returns a result if a plugin command was matched and executed,
 * or null to continue to the next handler.
 */
export const handlePluginCommand: CommandHandler = async (
  params,
  allowTextCommands,
): Promise<CommandHandlerResult | null> => {
  const { command, cfg } = params;

  if (!allowTextCommands) {
    return null;
  }

  // Try to match a plugin command
  const match = matchPluginCommand(command.commandBodyNormalized);
  if (!match) {
    return null;
  }

  // Execute the plugin command (always returns a result)
  const result = await executePluginCommand({
    accountId: params.ctx.AccountId ?? undefined,
    args: match.args,
    channel: command.channel,
    channelId: command.channelId,
    command: match.command,
    commandBody: command.commandBodyNormalized,
    config: cfg,
    from: command.from,
    gatewayClientScopes: params.ctx.GatewayClientScopes,
    isAuthorizedSender: command.isAuthorizedSender,
    messageThreadId:
      typeof params.ctx.MessageThreadId === "string" ||
      typeof params.ctx.MessageThreadId === "number"
        ? params.ctx.MessageThreadId
        : undefined,
    senderId: command.senderId,
    sessionId: params.sessionEntry?.sessionId,
    sessionKey: params.sessionKey,
    threadParentId: normalizeOptionalString(params.ctx.ThreadParentId),
    to: command.to,
  });

  return {
    reply: result,
    shouldContinue: false,
  };
};
