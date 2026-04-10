import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveToolInventory } from "../../agents/tools-effective-inventory.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { logVerbose } from "../../globals.js";
import { listSkillCommandsForAgents } from "../skill-commands.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  buildToolsMessage,
} from "../status.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import { resolveChannelAccountId } from "./channel-context.js";
import { buildExportSessionReply } from "./commands-export-session.js";
import { buildStatusReply } from "./commands-status.js";
import type { CommandHandler } from "./commands-types.js";
import { extractExplicitGroupId } from "./group-id.js";
import { resolveReplyToMode } from "./reply-threading.js";
export { handleContextCommand } from "./commands-context-command.js";
export { handleWhoamiCommand } from "./commands-whoami.js";

export const handleHelpCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/help") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /help from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  return {
    reply: { text: buildHelpMessage(params.cfg) },
    shouldContinue: false,
  };
};

export const handleCommandsListCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/commands") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /commands from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const skillCommands =
    params.skillCommands ??
    listSkillCommandsForAgents({
      agentIds: params.agentId ? [params.agentId] : undefined,
      cfg: params.cfg,
    });
  const surface = params.ctx.Surface;
  const commandPlugin = surface ? getChannelPlugin(surface) : null;
  const paginated = buildCommandsMessagePaginated(params.cfg, skillCommands, {
    page: 1,
    surface,
  });
  const channelData = commandPlugin?.commands?.buildCommandsListChannelData?.({
    agentId: params.agentId,
    currentPage: paginated.currentPage,
    totalPages: paginated.totalPages,
  });
  if (channelData) {
    return {
      reply: {
        channelData,
        text: paginated.text,
      },
      shouldContinue: false,
    };
  }

  return {
    reply: { text: buildCommandsMessage(params.cfg, skillCommands, { surface }) },
    shouldContinue: false,
  };
};

export const handleToolsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  let verbose = false;
  if (normalized === "/tools" || normalized === "/tools compact") {
    verbose = false;
  } else if (normalized === "/tools verbose") {
    verbose = true;
  } else if (normalized.startsWith("/tools ")) {
    return { reply: { text: "Usage: /tools [compact|verbose]" }, shouldContinue: false };
  } else {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /tools from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  try {
    const effectiveAccountId = resolveChannelAccountId({
      cfg: params.cfg,
      command: params.command,
      ctx: params.ctx,
    });
    const agentId =
      params.agentId ??
      resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey });
    const threadingContext = buildThreadingToolContext({
      config: params.cfg,
      hasRepliedRef: undefined,
      sessionCtx: params.ctx,
    });
    const result = resolveEffectiveToolInventory({
      accountId: effectiveAccountId,
      agentDir: params.agentDir,
      agentId,
      cfg: params.cfg,
      currentChannelId: threadingContext.currentChannelId,
      currentMessageId: threadingContext.currentMessageId,
      currentThreadTs:
        typeof params.ctx.MessageThreadId === "string" ||
        typeof params.ctx.MessageThreadId === "number"
          ? String(params.ctx.MessageThreadId)
          : undefined,
      groupChannel:
        params.sessionEntry?.groupChannel ?? params.ctx.GroupChannel ?? params.ctx.GroupSubject,
      groupId: params.sessionEntry?.groupId ?? extractExplicitGroupId(params.ctx.From),
      groupSpace: params.sessionEntry?.space ?? params.ctx.GroupSpace,
      messageProvider: params.command.channel,
      modelId: params.model,
      modelProvider: params.provider,
      replyToMode: resolveReplyToMode(
        params.cfg,
        params.ctx.OriginatingChannel ?? params.ctx.Provider,
        effectiveAccountId,
        params.ctx.ChatType,
      ),
      senderE164: params.ctx.SenderE164,
      senderId: params.command.senderId,
      senderIsOwner: params.command.senderIsOwner,
      senderName: params.ctx.SenderName,
      senderUsername: params.ctx.SenderUsername,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
    });
    return {
      reply: { text: buildToolsMessage(result, { verbose }) },
      shouldContinue: false,
    };
  } catch (error) {
    const message = String(error);
    const text = message.includes("missing scope:")
      ? "You do not have permission to view available tools."
      : "Couldn't load available tools right now. Try again in a moment.";
    return {
      reply: { text },
      shouldContinue: false,
    };
  }
};

export const handleStatusCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const statusRequested =
    params.directives.hasStatusDirective || params.command.commandBodyNormalized === "/status";
  if (!statusRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /status from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const reply = await buildStatusReply({
    cfg: params.cfg,
    command: params.command,
    contextTokens: params.contextTokens,
    defaultGroupActivation: params.defaultGroupActivation,
    isGroup: params.isGroup,
    mediaDecisions: params.ctx.MediaUnderstandingDecisions,
    model: params.model,
    parentSessionKey: params.ctx.ParentSessionKey,
    provider: params.provider,
    resolveDefaultThinkingLevel: params.resolveDefaultThinkingLevel,
    resolvedElevatedLevel: params.resolvedElevatedLevel,
    resolvedReasoningLevel: params.resolvedReasoningLevel,
    resolvedThinkLevel: params.resolvedThinkLevel,
    resolvedVerboseLevel: params.resolvedVerboseLevel,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    sessionScope: params.sessionScope,
  });
  return { reply, shouldContinue: false };
};

export const handleExportSessionCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (
    normalized !== "/export-session" &&
    !normalized.startsWith("/export-session ") &&
    normalized !== "/export" &&
    !normalized.startsWith("/export ")
  ) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /export-session from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  return { reply: await buildExportSessionReply(params), shouldContinue: false };
};
