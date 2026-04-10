import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/agent-runtime";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { normalizeInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalStringifiedId } from "openclaw/plugin-sdk/text-runtime";
import { handleDiscordAction } from "../../action-runtime-api.js";
import { buildDiscordInteractiveComponents } from "../shared-interactive.js";
import { resolveDiscordChannelId } from "../targets.js";
import { tryHandleDiscordMessageActionGuildAdmin } from "./handle-action.guild-admin.js";
import { readDiscordParentIdParam } from "./runtime.shared.js";

const providerId = "discord";

export async function handleDiscordMessageAction(
  ctx: Pick<
    ChannelMessageActionContext,
    | "action"
    | "params"
    | "cfg"
    | "accountId"
    | "requesterSenderId"
    | "toolContext"
    | "mediaAccess"
    | "mediaLocalRoots"
    | "mediaReadFile"
  >,
): Promise<AgentToolResult<unknown>> {
  const { action, params, cfg } = ctx;
  const accountId = ctx.accountId ?? readStringParam(params, "accountId");
  const actionOptions = {
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
  } as const;

  const resolveChannelId = () =>
    resolveDiscordChannelId(
      readStringParam(params, "channelId") ?? readStringParam(params, "to", { required: true }),
    );

  if (action === "send") {
    const to = readStringParam(params, "to", { required: true });
    const asVoice = readBooleanParam(params, "asVoice") === true;
    const rawComponents =
      params.components ??
      buildDiscordInteractiveComponents(normalizeInteractiveReply(params.interactive));
    const hasComponents =
      Boolean(rawComponents) &&
      (typeof rawComponents === "function" || typeof rawComponents === "object");
    const components = hasComponents ? rawComponents : undefined;
    const content = readStringParam(params, "message", {
      allowEmpty: true,
      required: !asVoice && !hasComponents,
    });
    // Support media, path, and filePath for media URL
    const mediaUrl =
      readStringParam(params, "media", { trim: false }) ??
      readStringParam(params, "path", { trim: false }) ??
      readStringParam(params, "filePath", { trim: false });
    const filename = readStringParam(params, "filename");
    const replyTo = readStringParam(params, "replyTo");
    const rawEmbeds = params.embeds;
    const embeds = Array.isArray(rawEmbeds) ? rawEmbeds : undefined;
    const silent = readBooleanParam(params, "silent") === true;
    const sessionKey = readStringParam(params, "__sessionKey");
    const agentId = readStringParam(params, "__agentId");
    return await handleDiscordAction(
      {
        __agentId: agentId ?? undefined,
        __sessionKey: sessionKey ?? undefined,
        accountId: accountId ?? undefined,
        action: "sendMessage",
        asVoice,
        components,
        content,
        embeds,
        filename: filename ?? undefined,
        mediaUrl: mediaUrl ?? undefined,
        replyTo: replyTo ?? undefined,
        silent,
        to,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "poll") {
    const to = readStringParam(params, "to", { required: true });
    const question = readStringParam(params, "pollQuestion", {
      required: true,
    });
    const answers = readStringArrayParam(params, "pollOption", { required: true });
    const allowMultiselect = readBooleanParam(params, "pollMulti");
    const durationHours = readNumberParam(params, "pollDurationHours", {
      integer: true,
      strict: true,
    });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "poll",
        allowMultiselect,
        answers,
        content: readStringParam(params, "message"),
        durationHours: durationHours ?? undefined,
        question,
        to,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "react") {
    const messageIdRaw = resolveReactionMessageId({ args: params, toolContext: ctx.toolContext });
    const messageId = normalizeOptionalStringifiedId(messageIdRaw) ?? "";
    if (!messageId) {
      throw new Error(
        "messageId required. Provide messageId explicitly or react to the current inbound message.",
      );
    }
    const emoji = readStringParam(params, "emoji", { allowEmpty: true });
    const remove = readBooleanParam(params, "remove");
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "react",
        channelId: resolveChannelId(),
        emoji,
        messageId,
        remove,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "reactions") {
    const messageId = readStringParam(params, "messageId", { required: true });
    const limit = readNumberParam(params, "limit", { integer: true });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "reactions",
        channelId: resolveChannelId(),
        limit,
        messageId,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "read") {
    const limit = readNumberParam(params, "limit", { integer: true });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "readMessages",
        after: readStringParam(params, "after"),
        around: readStringParam(params, "around"),
        before: readStringParam(params, "before"),
        channelId: resolveChannelId(),
        limit,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "edit") {
    const messageId = readStringParam(params, "messageId", { required: true });
    const content = readStringParam(params, "message", { required: true });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "editMessage",
        channelId: resolveChannelId(),
        content,
        messageId,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "delete") {
    const messageId = readStringParam(params, "messageId", { required: true });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "deleteMessage",
        channelId: resolveChannelId(),
        messageId,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "pin" || action === "unpin" || action === "list-pins") {
    const messageId =
      action === "list-pins" ? undefined : readStringParam(params, "messageId", { required: true });
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: action === "pin" ? "pinMessage" : (action === "unpin" ? "unpinMessage" : "listPins"),
        channelId: resolveChannelId(),
        messageId,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "permissions") {
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "permissions",
        channelId: resolveChannelId(),
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "thread-create") {
    const name = readStringParam(params, "threadName", { required: true });
    const messageId = readStringParam(params, "messageId");
    const content = readStringParam(params, "message");
    const autoArchiveMinutes = readNumberParam(params, "autoArchiveMin", {
      integer: true,
    });
    const appliedTags = readStringArrayParam(params, "appliedTags");
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "threadCreate",
        appliedTags: appliedTags ?? undefined,
        autoArchiveMinutes,
        channelId: resolveChannelId(),
        content,
        messageId,
        name,
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "sticker") {
    const stickerIds =
      readStringArrayParam(params, "stickerId", {
        label: "sticker-id",
        required: true,
      }) ?? [];
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "sticker",
        content: readStringParam(params, "message"),
        stickerIds,
        to: readStringParam(params, "to", { required: true }),
      },
      cfg,
      actionOptions,
    );
  }

  if (action === "set-presence") {
    return await handleDiscordAction(
      {
        accountId: accountId ?? undefined,
        action: "setPresence",
        activityName: readStringParam(params, "activityName"),
        activityState: readStringParam(params, "activityState"),
        activityType: readStringParam(params, "activityType"),
        activityUrl: readStringParam(params, "activityUrl"),
        status: readStringParam(params, "status"),
      },
      cfg,
      actionOptions,
    );
  }

  const adminResult = await tryHandleDiscordMessageActionGuildAdmin({
    ctx,
    readParentIdParam: readDiscordParentIdParam,
    resolveChannelId,
  });
  if (adminResult !== undefined) {
    return adminResult;
  }

  throw new Error(`Action ${String(action)} is not supported for provider ${providerId}.`);
}
