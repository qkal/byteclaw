import { createMessageToolCardSchema } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { ChannelMessageActionName, ChannelPlugin } from "./channel-api.js";
import { resolveMSTeamsCredentials } from "./token.js";

const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "msTeamsChannelRuntime",
);

function jsonActionResult(data: Record<string, unknown>) {
  const text = JSON.stringify(data);
  return {
    content: [{ text, type: "text" as const }],
    details: data,
  };
}

function jsonMSTeamsActionResult(action: string, data: Record<string, unknown> = {}) {
  return jsonActionResult({ action, channel: "msteams", ...data });
}

function jsonMSTeamsOkActionResult(action: string, data: Record<string, unknown> = {}) {
  return jsonActionResult({ action, channel: "msteams", ok: true, ...data });
}

function jsonMSTeamsConversationResult(conversationId: string | undefined) {
  return jsonActionResultWithDetails(
    {
      channel: "msteams",
      conversationId,
      ok: true,
    },
    { channel: "msteams", ok: true },
  );
}

function jsonActionResultWithDetails(
  contentData: Record<string, unknown>,
  details: Record<string, unknown>,
) {
  return {
    content: [{ text: JSON.stringify(contentData), type: "text" as const }],
    details,
  };
}

const MSTEAMS_REACTION_TYPES = ["like", "heart", "laugh", "surprised", "sad", "angry"] as const;

function actionError(message: string) {
  return {
    content: [{ text: message, type: "text" as const }],
    details: { error: message },
    isError: true as const,
  };
}

function resolveActionTarget(
  params: Record<string, unknown>,
  currentChannelId?: string | null,
): string {
  return typeof params.to === "string"
    ? params.to.trim()
    : (typeof params.target === "string"
      ? params.target.trim()
      : (currentChannelId?.trim() ?? ""));
}

function resolveActionMessageId(params: Record<string, unknown>): string {
  return normalizeOptionalString(params.messageId) ?? "";
}

function resolveActionPinnedMessageId(params: Record<string, unknown>): string {
  return typeof params.pinnedMessageId === "string"
    ? params.pinnedMessageId.trim()
    : (typeof params.messageId === "string"
      ? params.messageId.trim()
      : "");
}

function resolveActionQuery(params: Record<string, unknown>): string {
  return normalizeOptionalString(params.query) ?? "";
}

function resolveActionContent(params: Record<string, unknown>): string {
  return typeof params.text === "string"
    ? params.text
    : typeof params.content === "string"
      ? params.content
      : typeof params.message === "string"
        ? params.message
        : "";
}

function resolveActionUploadFilePath(params: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "path", "media"] as const) {
    if (typeof params[key] === "string") {
      const value = params[key];
      if (value.trim()) {
        return value;
      }
    }
  }
  return undefined;
}

function resolveRequiredActionTarget(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
}): string | ReturnType<typeof actionError> {
  const to = resolveActionTarget(params.toolParams, params.currentChannelId);
  if (!to) {
    return actionError(`${params.actionLabel} requires a target (to).`);
  }
  return to;
}

function resolveRequiredActionMessageTarget(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
}): { to: string; messageId: string } | ReturnType<typeof actionError> {
  const to = resolveActionTarget(params.toolParams, params.currentChannelId);
  const messageId = resolveActionMessageId(params.toolParams);
  if (!to || !messageId) {
    return actionError(`${params.actionLabel} requires a target (to) and messageId.`);
  }
  return { messageId, to };
}

function resolveRequiredActionPinnedMessageTarget(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
}): { to: string; pinnedMessageId: string } | ReturnType<typeof actionError> {
  const to = resolveActionTarget(params.toolParams, params.currentChannelId);
  const pinnedMessageId = resolveActionPinnedMessageId(params.toolParams);
  if (!to || !pinnedMessageId) {
    return actionError(`${params.actionLabel} requires a target (to) and pinnedMessageId.`);
  }
  return { pinnedMessageId, to };
}

async function runWithRequiredActionTarget<T>(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  run: (to: string) => Promise<T>;
}): Promise<T | ReturnType<typeof actionError>> {
  const to = resolveRequiredActionTarget({
    actionLabel: params.actionLabel,
    currentChannelId: params.currentChannelId,
    toolParams: params.toolParams,
  });
  if (typeof to !== "string") {
    return to;
  }
  return await params.run(to);
}

async function runWithRequiredActionMessageTarget<T>(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  run: (target: { to: string; messageId: string }) => Promise<T>;
}): Promise<T | ReturnType<typeof actionError>> {
  const target = resolveRequiredActionMessageTarget({
    actionLabel: params.actionLabel,
    currentChannelId: params.currentChannelId,
    toolParams: params.toolParams,
  });
  if ("isError" in target) {
    return target;
  }
  return await params.run(target);
}

async function runWithRequiredActionPinnedMessageTarget<T>(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  run: (target: { to: string; pinnedMessageId: string }) => Promise<T>;
}): Promise<T | ReturnType<typeof actionError>> {
  const target = resolveRequiredActionPinnedMessageTarget({
    actionLabel: params.actionLabel,
    currentChannelId: params.currentChannelId,
    toolParams: params.toolParams,
  });
  if ("isError" in target) {
    return target;
  }
  return await params.run(target);
}

export function describeMSTeamsMessageTool({
  cfg,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const enabled =
    cfg.channels?.msteams?.enabled !== false &&
    Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams));
  return {
    actions: enabled
      ? ([
          "upload-file",
          "poll",
          "edit",
          "delete",
          "pin",
          "unpin",
          "list-pins",
          "read",
          "react",
          "reactions",
          "search",
          "member-info",
          "channel-list",
          "channel-info",
        ] satisfies ChannelMessageActionName[])
      : [],
    capabilities: enabled ? ["cards"] : [],
    schema: enabled
      ? {
          properties: {
            card: createMessageToolCardSchema(),
          },
        }
      : null,
  };
}

export const msteamsActionsAdapter: NonNullable<ChannelPlugin["actions"]> = {
  describeMessageTool: describeMSTeamsMessageTool,
  handleAction: async (ctx) => {
    if (ctx.action === "send" && ctx.params.card) {
      const card = ctx.params.card as Record<string, unknown>;
      return await runWithRequiredActionTarget({
        actionLabel: "Card send",
        run: async (to) => {
          const { sendAdaptiveCardMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await sendAdaptiveCardMSTeams({
            card,
            cfg: ctx.cfg,
            to,
          });
          return jsonActionResultWithDetails(
            {
              channel: "msteams",
              conversationId: result.conversationId,
              messageId: result.messageId,
              ok: true,
            },
            { channel: "msteams", messageId: result.messageId, ok: true },
          );
        },
        toolParams: ctx.params,
      });
    }
    if (ctx.action === "upload-file") {
      const mediaUrl = resolveActionUploadFilePath(ctx.params);
      if (!mediaUrl) {
        return actionError("Upload-file requires media, filePath, or path.");
      }
      return await runWithRequiredActionTarget({
        actionLabel: "Upload-file",
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (to) => {
          const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await sendMessageMSTeams({
            cfg: ctx.cfg,
            filename:
              normalizeOptionalString(ctx.params.filename) ??
              normalizeOptionalString(ctx.params.title),
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            mediaUrl,
            text: resolveActionContent(ctx.params),
            to,
          });
          return jsonActionResultWithDetails(
            {
              action: "upload-file",
              channel: "msteams",
              conversationId: result.conversationId,
              messageId: result.messageId,
              ok: true,
              ...(result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}),
            },
            {
              channel: "msteams",
              messageId: result.messageId,
              ok: true,
              ...(result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}),
            },
          );
        },
        toolParams: ctx.params,
      });
    }
    if (ctx.action === "edit") {
      const content = resolveActionContent(ctx.params);
      if (!content) {
        return actionError("Edit requires content.");
      }
      return await runWithRequiredActionMessageTarget({
        actionLabel: "Edit",
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (target) => {
          const { editMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await editMessageMSTeams({
            activityId: target.messageId,
            cfg: ctx.cfg,
            text: content,
            to: target.to,
          });
          return jsonMSTeamsConversationResult(result.conversationId);
        },
        toolParams: ctx.params,
      });
    }

    if (ctx.action === "delete") {
      return await runWithRequiredActionMessageTarget({
        actionLabel: "Delete",
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (target) => {
          const { deleteMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await deleteMessageMSTeams({
            activityId: target.messageId,
            cfg: ctx.cfg,
            to: target.to,
          });
          return jsonMSTeamsConversationResult(result.conversationId);
        },
        toolParams: ctx.params,
      });
    }

    if (ctx.action === "read") {
      return await runWithRequiredActionMessageTarget({
        actionLabel: "Read",
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (target) => {
          const { getMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const message = await getMessageMSTeams({
            cfg: ctx.cfg,
            messageId: target.messageId,
            to: target.to,
          });
          return jsonMSTeamsOkActionResult("read", { message });
        },
        toolParams: ctx.params,
      });
    }

    if (ctx.action === "pin") {
      return await runWithRequiredActionMessageTarget({
        actionLabel: "Pin",
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (target) => {
          const { pinMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await pinMessageMSTeams({
            cfg: ctx.cfg,
            messageId: target.messageId,
            to: target.to,
          });
          return jsonMSTeamsActionResult("pin", result);
        },
        toolParams: ctx.params,
      });
    }

    if (ctx.action === "unpin") {
      return await runWithRequiredActionPinnedMessageTarget({
        actionLabel: "Unpin",
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (target) => {
          const { unpinMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await unpinMessageMSTeams({
            cfg: ctx.cfg,
            pinnedMessageId: target.pinnedMessageId,
            to: target.to,
          });
          return jsonMSTeamsActionResult("unpin", result);
        },
        toolParams: ctx.params,
      });
    }

    if (ctx.action === "list-pins") {
      return await runWithRequiredActionTarget({
        actionLabel: "List-pins",
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (to) => {
          const { listPinsMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await listPinsMSTeams({ cfg: ctx.cfg, to });
          return jsonMSTeamsOkActionResult("list-pins", result);
        },
        toolParams: ctx.params,
      });
    }

    if (ctx.action === "react") {
      return await runWithRequiredActionMessageTarget({
        actionLabel: "React",
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (target) => {
          const emoji = normalizeOptionalString(ctx.params.emoji) ?? "";
          const remove = typeof ctx.params.remove === "boolean" ? ctx.params.remove : false;
          if (!emoji) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `React requires an emoji (reaction type). Valid types: ${MSTEAMS_REACTION_TYPES.join(", ")}.`,
                },
              ],
              details: {
                error: "React requires an emoji (reaction type).",
                validTypes: [...MSTEAMS_REACTION_TYPES],
              },
              isError: true,
            };
          }
          if (remove) {
            const { unreactMessageMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await unreactMessageMSTeams({
              cfg: ctx.cfg,
              messageId: target.messageId,
              reactionType: emoji,
              to: target.to,
            });
            return jsonMSTeamsActionResult("react", {
              reactionType: emoji,
              removed: true,
              ...result,
            });
          }
          const { reactMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await reactMessageMSTeams({
            cfg: ctx.cfg,
            messageId: target.messageId,
            reactionType: emoji,
            to: target.to,
          });
          return jsonMSTeamsActionResult("react", {
            reactionType: emoji,
            ...result,
          });
        },
        toolParams: ctx.params,
      });
    }

    if (ctx.action === "reactions") {
      return await runWithRequiredActionMessageTarget({
        actionLabel: "Reactions",
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (target) => {
          const { listReactionsMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await listReactionsMSTeams({
            cfg: ctx.cfg,
            messageId: target.messageId,
            to: target.to,
          });
          return jsonMSTeamsOkActionResult("reactions", result);
        },
        toolParams: ctx.params,
      });
    }

    if (ctx.action === "search") {
      return await runWithRequiredActionTarget({
        actionLabel: "Search",
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (to) => {
          const query = resolveActionQuery(ctx.params);
          if (!query) {
            return actionError("Search requires a target (to) and query.");
          }
          const limit = typeof ctx.params.limit === "number" ? ctx.params.limit : undefined;
          const from = normalizeOptionalString(ctx.params.from);
          const { searchMessagesMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await searchMessagesMSTeams({
            cfg: ctx.cfg,
            from: from || undefined,
            limit,
            query,
            to,
          });
          return jsonMSTeamsOkActionResult("search", result);
        },
        toolParams: ctx.params,
      });
    }

    if (ctx.action === "member-info") {
      const userId = normalizeOptionalString(ctx.params.userId) ?? "";
      if (!userId) {
        return actionError("member-info requires a userId.");
      }
      const { getMemberInfoMSTeams } = await loadMSTeamsChannelRuntime();
      const result = await getMemberInfoMSTeams({ cfg: ctx.cfg, userId });
      return jsonMSTeamsOkActionResult("member-info", result);
    }

    if (ctx.action === "channel-list") {
      const teamId = normalizeOptionalString(ctx.params.teamId) ?? "";
      if (!teamId) {
        return actionError("channel-list requires a teamId.");
      }
      const { listChannelsMSTeams } = await loadMSTeamsChannelRuntime();
      const result = await listChannelsMSTeams({ cfg: ctx.cfg, teamId });
      return jsonMSTeamsOkActionResult("channel-list", result);
    }

    if (ctx.action === "channel-info") {
      const teamId = normalizeOptionalString(ctx.params.teamId) ?? "";
      const channelId = normalizeOptionalString(ctx.params.channelId) ?? "";
      if (!teamId || !channelId) {
        return actionError("channel-info requires teamId and channelId.");
      }
      const { getChannelInfoMSTeams } = await loadMSTeamsChannelRuntime();
      const result = await getChannelInfoMSTeams({
        cfg: ctx.cfg,
        channelId,
        teamId,
      });
      return jsonMSTeamsOkActionResult("channel-info", {
        channelInfo: result.channel,
      });
    }

    return null as never;
  },
};
