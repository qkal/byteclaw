import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  OpenClawConfig,
} from "../runtime-api.js";
import {
  createActionGate,
  extractToolSend,
  jsonResult,
  loadOutboundMediaFromUrl,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../runtime-api.js";
import { listEnabledGoogleChatAccounts, resolveGoogleChatAccount } from "./accounts.js";
import {
  createGoogleChatReaction,
  deleteGoogleChatReaction,
  listGoogleChatReactions,
  sendGoogleChatMessage,
  uploadGoogleChatAttachment,
} from "./api.js";
import { getGoogleChatRuntime } from "./runtime.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const providerId = "googlechat";

function listEnabledAccounts(cfg: OpenClawConfig) {
  return listEnabledGoogleChatAccounts(cfg).filter(
    (account) => account.enabled && account.credentialSource !== "none",
  );
}

function isReactionsEnabled(accounts: { config: { actions?: unknown } }[]) {
  for (const account of accounts) {
    const gate = createActionGate(account.config.actions as Record<string, boolean | undefined>);
    if (gate("reactions")) {
      return true;
    }
  }
  return false;
}

function resolveAppUserNames(account: { config: { botUser?: string | null } }) {
  return new Set(["users/app", account.config.botUser?.trim()].filter(Boolean) as string[]);
}

async function loadGoogleChatActionMedia(params: {
  mediaUrl: string;
  maxBytes: number;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}) {
  const runtime = getGoogleChatRuntime();
  return /^https?:\/\//i.test(params.mediaUrl)
    ? await runtime.channel.media.fetchRemoteMedia({
        maxBytes: params.maxBytes,
        url: params.mediaUrl,
      })
    : await loadOutboundMediaFromUrl(params.mediaUrl, {
        maxBytes: params.maxBytes,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaLocalRoots,
        mediaReadFile: params.mediaReadFile,
      });
}

export const googlechatMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const accounts = accountId
      ? [resolveGoogleChatAccount({ accountId, cfg })].filter(
          (account) => account.enabled && account.credentialSource !== "none",
        )
      : listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return null;
    }
    const actions = new Set<ChannelMessageActionName>([]);
    actions.add("send");
    actions.add("upload-file");
    if (isReactionsEnabled(accounts)) {
      actions.add("react");
      actions.add("reactions");
    }
    return { actions: [...actions] };
  },
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
  }) => {
    const account = resolveGoogleChatAccount({
      accountId,
      cfg,
    });
    if (account.credentialSource === "none") {
      throw new Error("Google Chat credentials are missing.");
    }

    if (action === "send" || action === "upload-file") {
      const to = readStringParam(params, "to", { required: true });
      const content =
        readStringParam(params, "message", {
          allowEmpty: true,
          required: action === "send",
        }) ??
        readStringParam(params, "initialComment", {
          allowEmpty: true,
        }) ??
        "";
      const mediaUrl =
        readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false }) ??
        readStringParam(params, "path", { trim: false });
      const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });

      if (mediaUrl) {
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        const loaded = await loadGoogleChatActionMedia({
          maxBytes,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
          mediaUrl,
        });
        const uploadFileName =
          readStringParam(params, "filename") ??
          readStringParam(params, "title") ??
          loaded.fileName ??
          "attachment";
        const upload = await uploadGoogleChatAttachment({
          account,
          buffer: loaded.buffer,
          contentType: loaded.contentType,
          filename: uploadFileName,
          space,
        });
        await sendGoogleChatMessage({
          account,
          attachments: upload.attachmentUploadToken
            ? [
                {
                  attachmentUploadToken: upload.attachmentUploadToken,
                  contentName: uploadFileName,
                },
              ]
            : undefined,
          space,
          text: content,
          thread: threadId ?? undefined,
        });
        return jsonResult({ ok: true, to: space });
      }

      if (action === "upload-file") {
        throw new Error("upload-file requires media, filePath, or path");
      }

      await sendGoogleChatMessage({
        account,
        space,
        text: content,
        thread: threadId ?? undefined,
      });
      return jsonResult({ ok: true, to: space });
    }

    if (action === "react") {
      const messageName = readStringParam(params, "messageId", { required: true });
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Google Chat reaction.",
      });
      if (remove || isEmpty) {
        const reactions = await listGoogleChatReactions({ account, messageName });
        const appUsers = resolveAppUserNames(account);
        const toRemove = reactions.filter((reaction) => {
          const userName = reaction.user?.name?.trim();
          if (appUsers.size > 0 && !appUsers.has(userName ?? "")) {
            return false;
          }
          if (emoji) {
            return reaction.emoji?.unicode === emoji;
          }
          return true;
        });
        for (const reaction of toRemove) {
          if (!reaction.name) {
            continue;
          }
          await deleteGoogleChatReaction({ account, reactionName: reaction.name });
        }
        return jsonResult({ ok: true, removed: toRemove.length });
      }
      const reaction = await createGoogleChatReaction({
        account,
        emoji,
        messageName,
      });
      return jsonResult({ ok: true, reaction });
    }

    if (action === "reactions") {
      const messageName = readStringParam(params, "messageId", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const reactions = await listGoogleChatReactions({
        account,
        limit: limit ?? undefined,
        messageName,
      });
      return jsonResult({ ok: true, reactions });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
