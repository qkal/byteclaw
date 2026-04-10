import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-runtime";
import { type OpenClawConfig, loadOutboundMediaFromUrl } from "../runtime-api.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import { prepareFileConsentActivity, requiresFileConsent } from "./file-consent-helpers.js";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import {
  getDriveItemProperties,
  uploadAndShareOneDrive,
  uploadAndShareSharePoint,
} from "./graph-upload.js";
import { extractFilename, extractMessageId } from "./media-helpers.js";
import { buildConversationReference, sendMSTeamsMessages } from "./messenger.js";
import { buildMSTeamsPollCard } from "./polls.js";
import { type MSTeamsProactiveContext, resolveMSTeamsSendContext } from "./send-context.js";

export interface SendMSTeamsMessageParams {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Message text */
  text: string;
  /** Optional media URL */
  mediaUrl?: string;
  /** Optional filename override for uploaded media/files */
  filename?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}

export interface SendMSTeamsMessageResult {
  messageId: string;
  conversationId: string;
  /** If a FileConsentCard was sent instead of the file, this contains the upload ID */
  pendingUploadId?: string;
}

/** Threshold for large files that require FileConsentCard flow in personal chats */
const FILE_CONSENT_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4MB

/**
 * MSTeams-specific media size limit (100MB).
 * Higher than the default because OneDrive upload handles large files well.
 */
const MSTEAMS_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export interface SendMSTeamsPollParams {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Poll question */
  question: string;
  /** Poll options */
  options: string[];
  /** Max selections (defaults to 1) */
  maxSelections?: number;
}

export interface SendMSTeamsPollResult {
  pollId: string;
  messageId: string;
  conversationId: string;
}

export interface SendMSTeamsCardParams {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Adaptive Card JSON object */
  card: Record<string, unknown>;
}

export interface SendMSTeamsCardResult {
  messageId: string;
  conversationId: string;
}

/**
 * Send a message to a Teams conversation or user.
 *
 * Uses the stored ConversationReference from previous interactions.
 * The bot must have received at least one message from the conversation
 * before proactive messaging works.
 *
 * File handling by conversation type:
 * - Personal (1:1) chats: small images (<4MB) use base64, large files and non-images use FileConsentCard
 * - Group chats / channels: files are uploaded to OneDrive and shared via link
 */
export async function sendMessageMSTeams(
  params: SendMSTeamsMessageParams,
): Promise<SendMSTeamsMessageResult> {
  const { cfg, to, text, mediaUrl, filename, mediaLocalRoots, mediaReadFile } = params;
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "msteams",
  });
  const messageText = convertMarkdownTables(text ?? "", tableMode);
  const ctx = await resolveMSTeamsSendContext({ cfg, to });
  const {
    adapter,
    appId,
    conversationId,
    ref,
    log,
    conversationType,
    tokenProvider,
    sharePointSiteId,
  } = ctx;

  log.debug?.("sending proactive message", {
    conversationId,
    conversationType,
    hasMedia: Boolean(mediaUrl),
    textLength: messageText.length,
  });

  // Handle media if present
  if (mediaUrl) {
    const mediaMaxBytes = ctx.mediaMaxBytes ?? MSTEAMS_MAX_MEDIA_BYTES;
    const media = await loadOutboundMediaFromUrl(mediaUrl, {
      maxBytes: mediaMaxBytes,
      mediaLocalRoots,
      mediaReadFile,
    });
    const isLargeFile = media.buffer.length >= FILE_CONSENT_THRESHOLD_BYTES;
    const isImage = media.contentType?.startsWith("image/") ?? false;
    const fallbackFileName = await extractFilename(mediaUrl);
    const fileName = filename?.trim() || media.fileName || fallbackFileName;

    log.debug?.("processing media", {
      contentType: media.contentType,
      conversationType,
      fileName,
      isImage,
      isLargeFile,
      size: media.buffer.length,
    });

    // Personal chats: base64 only works for images; use FileConsentCard for large files or non-images
    if (
      requiresFileConsent({
        bufferSize: media.buffer.length,
        contentType: media.contentType,
        conversationType,
        thresholdBytes: FILE_CONSENT_THRESHOLD_BYTES,
      })
    ) {
      const { activity, uploadId } = prepareFileConsentActivity({
        conversationId,
        description: messageText || undefined,
        media: { buffer: media.buffer, contentType: media.contentType, filename: fileName },
      });

      log.debug?.("sending file consent card", { fileName, size: media.buffer.length, uploadId });

      const messageId = await sendProactiveActivity({
        activity,
        adapter,
        appId,
        errorPrefix: "msteams consent card send",
        ref,
      });

      log.info("sent file consent card", { conversationId, messageId, uploadId });

      return {
        conversationId,
        messageId,
        pendingUploadId: uploadId,
      };
    }

    // Personal chat with small image: use base64 (only works for images)
    if (conversationType === "personal") {
      // Small image in personal chat: use base64 (only works for images)
      const base64 = media.buffer.toString("base64");
      const finalMediaUrl = `data:${media.contentType};base64,${base64}`;

      return sendTextWithMedia(ctx, messageText, finalMediaUrl);
    }

    if (isImage && !sharePointSiteId) {
      // Group chat/channel without SharePoint: send image inline (avoids OneDrive failures)
      const base64 = media.buffer.toString("base64");
      const finalMediaUrl = `data:${media.contentType};base64,${base64}`;
      return sendTextWithMedia(ctx, messageText, finalMediaUrl);
    }

    // Group chat or channel: upload to SharePoint (if siteId configured) or OneDrive
    try {
      if (sharePointSiteId) {
        // Use SharePoint upload + Graph API for native file card
        log.debug?.("uploading to SharePoint for native file card", {
          conversationType,
          fileName,
          siteId: sharePointSiteId,
        });

        const uploaded = await uploadAndShareSharePoint({
          buffer: media.buffer,
          filename: fileName,
          contentType: media.contentType,
          tokenProvider,
          siteId: sharePointSiteId,
          // Use the Graph-native chat ID (19:xxx format) — the Bot Framework conversationId
          // For personal DMs uses a different format that Graph API rejects.
          chatId: ctx.graphChatId ?? conversationId,
          usePerUserSharing: conversationType === "groupChat",
        });

        log.debug?.("SharePoint upload complete", {
          itemId: uploaded.itemId,
          shareUrl: uploaded.shareUrl,
        });

        // Get driveItem properties needed for native file card
        const driveItem = await getDriveItemProperties({
          itemId: uploaded.itemId,
          siteId: sharePointSiteId,
          tokenProvider,
        });

        log.debug?.("driveItem properties retrieved", {
          eTag: driveItem.eTag,
          webDavUrl: driveItem.webDavUrl,
        });

        // Build native Teams file card attachment and send via Bot Framework
        const fileCardAttachment = buildTeamsFileInfoCard(driveItem);
        const activity = {
          attachments: [fileCardAttachment],
          text: messageText || undefined,
          type: "message",
        };
        const messageId = await sendProactiveActivityRaw({
          activity,
          adapter,
          appId,
          ref,
        });

        log.info("sent native file card", {
          conversationId,
          fileName: driveItem.name,
          messageId,
        });

        return { conversationId, messageId };
      }

      // Fallback: no SharePoint site configured, use OneDrive with markdown link
      log.debug?.("uploading to OneDrive (no SharePoint site configured)", {
        conversationType,
        fileName,
      });

      const uploaded = await uploadAndShareOneDrive({
        buffer: media.buffer,
        contentType: media.contentType,
        filename: fileName,
        tokenProvider,
      });

      log.debug?.("OneDrive upload complete", {
        itemId: uploaded.itemId,
        shareUrl: uploaded.shareUrl,
      });

      // Send message with file link (Bot Framework doesn't support "reference" attachment type for sending)
      const fileLink = `📎 [${uploaded.name}](${uploaded.shareUrl})`;
      const activity = {
        text: messageText ? `${messageText}\n\n${fileLink}` : fileLink,
        type: "message",
      };
      const messageId = await sendProactiveActivityRaw({
        activity,
        adapter,
        appId,
        ref,
      });

      log.info("sent message with OneDrive file link", {
        conversationId,
        messageId,
        shareUrl: uploaded.shareUrl,
      });

      return { conversationId, messageId };
    } catch (error) {
      const classification = classifyMSTeamsSendError(error);
      const hint = formatMSTeamsSendErrorHint(classification);
      const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
      throw new Error(
        `msteams file send failed${status}: ${formatUnknownError(error)}${hint ? ` (${hint})` : ""}`,
        { cause: error },
      );
    }
  }

  // No media: send text only
  return sendTextWithMedia(ctx, messageText, undefined);
}

/**
 * Send a text message with optional base64 media URL.
 */
async function sendTextWithMedia(
  ctx: MSTeamsProactiveContext,
  text: string,
  mediaUrl: string | undefined,
): Promise<SendMSTeamsMessageResult> {
  const {
    adapter,
    appId,
    conversationId,
    ref,
    log,
    tokenProvider,
    sharePointSiteId,
    mediaMaxBytes,
  } = ctx;

  let messageIds: string[];
  try {
    messageIds = await sendMSTeamsMessages({
      adapter,
      appId,
      conversationRef: ref,
      mediaMaxBytes,
      messages: [{ mediaUrl, text: text || undefined }],
      onRetry: (event) => {
        log.debug?.("retrying send", { conversationId, ...event });
      },
      replyStyle: "top-level",
      retry: {},
      sharePointSiteId,
      tokenProvider,
    });
  } catch (error) {
    const classification = classifyMSTeamsSendError(error);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `msteams send failed${status}: ${formatUnknownError(error)}${hint ? ` (${hint})` : ""}`,
      { cause: error },
    );
  }

  const messageId = messageIds[0] ?? "unknown";
  log.info("sent proactive message", { conversationId, messageId });

  return {
    conversationId,
    messageId,
  };
}

interface ProactiveActivityParams {
  adapter: MSTeamsProactiveContext["adapter"];
  appId: string;
  ref: MSTeamsProactiveContext["ref"];
  activity: Record<string, unknown>;
  errorPrefix: string;
}

type ProactiveActivityRawParams = Omit<ProactiveActivityParams, "errorPrefix">;

async function sendProactiveActivityRaw({
  adapter,
  appId,
  ref,
  activity,
}: ProactiveActivityRawParams): Promise<string> {
  const baseRef = buildConversationReference(ref);
  const proactiveRef = {
    ...baseRef,
    activityId: undefined,
  };

  let messageId = "unknown";
  await adapter.continueConversation(appId, proactiveRef, async (ctx) => {
    const response = await ctx.sendActivity(activity);
    messageId = extractMessageId(response) ?? "unknown";
  });
  return messageId;
}

async function sendProactiveActivity({
  adapter,
  appId,
  ref,
  activity,
  errorPrefix,
}: ProactiveActivityParams): Promise<string> {
  try {
    return await sendProactiveActivityRaw({
      activity,
      adapter,
      appId,
      ref,
    });
  } catch (error) {
    const classification = classifyMSTeamsSendError(error);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `${errorPrefix} failed${status}: ${formatUnknownError(error)}${hint ? ` (${hint})` : ""}`,
      { cause: error },
    );
  }
}

/**
 * Send a poll (Adaptive Card) to a Teams conversation or user.
 */
export async function sendPollMSTeams(
  params: SendMSTeamsPollParams,
): Promise<SendMSTeamsPollResult> {
  const { cfg, to, question, options, maxSelections } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  const pollCard = buildMSTeamsPollCard({
    maxSelections,
    options,
    question,
  });

  log.debug?.("sending poll", {
    conversationId,
    optionCount: pollCard.options.length,
    pollId: pollCard.pollId,
  });

  const activity = {
    attachments: [
      {
        content: pollCard.card,
        contentType: "application/vnd.microsoft.card.adaptive",
      },
    ],
    type: "message",
  };

  // Send poll via proactive conversation (Adaptive Cards require direct activity send)
  const messageId = await sendProactiveActivity({
    activity,
    adapter,
    appId,
    errorPrefix: "msteams poll send",
    ref,
  });

  log.info("sent poll", { conversationId, messageId, pollId: pollCard.pollId });

  return {
    conversationId,
    messageId,
    pollId: pollCard.pollId,
  };
}

/**
 * Send an arbitrary Adaptive Card to a Teams conversation or user.
 */
export async function sendAdaptiveCardMSTeams(
  params: SendMSTeamsCardParams,
): Promise<SendMSTeamsCardResult> {
  const { cfg, to, card } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  log.debug?.("sending adaptive card", {
    cardType: card.type,
    cardVersion: card.version,
    conversationId,
  });

  const activity = {
    attachments: [
      {
        content: card,
        contentType: "application/vnd.microsoft.card.adaptive",
      },
    ],
    type: "message",
  };

  // Send card via proactive conversation
  const messageId = await sendProactiveActivity({
    activity,
    adapter,
    appId,
    errorPrefix: "msteams card send",
    ref,
  });

  log.info("sent adaptive card", { conversationId, messageId });

  return {
    conversationId,
    messageId,
  };
}

export interface EditMSTeamsMessageParams {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID */
  to: string;
  /** Activity ID of the message to edit */
  activityId: string;
  /** New message text */
  text: string;
}

export interface EditMSTeamsMessageResult {
  conversationId: string;
}

export interface DeleteMSTeamsMessageParams {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID */
  to: string;
  /** Activity ID of the message to delete */
  activityId: string;
}

export interface DeleteMSTeamsMessageResult {
  conversationId: string;
}

/**
 * Edit (update) a previously sent message in a Teams conversation.
 *
 * Uses the Bot Framework `continueConversation` → `updateActivity` flow
 * for proactive edits outside of the original turn context.
 */
export async function editMessageMSTeams(
  params: EditMSTeamsMessageParams,
): Promise<EditMSTeamsMessageResult> {
  const { cfg, to, activityId, text } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  log.debug?.("editing proactive message", { activityId, conversationId, textLength: text.length });

  const baseRef = buildConversationReference(ref);
  const proactiveRef = { ...baseRef, activityId: undefined };

  try {
    await adapter.continueConversation(appId, proactiveRef, async (ctx) => {
      await ctx.updateActivity({
        id: activityId,
        text,
        type: "message",
      });
    });
  } catch (error) {
    const classification = classifyMSTeamsSendError(error);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `msteams edit failed${status}: ${formatUnknownError(error)}${hint ? ` (${hint})` : ""}`,
      { cause: error },
    );
  }

  log.info("edited proactive message", { activityId, conversationId });

  return { conversationId };
}

/**
 * Delete a previously sent message in a Teams conversation.
 *
 * Uses the Bot Framework `continueConversation` → `deleteActivity` flow
 * for proactive deletes outside of the original turn context.
 */
export async function deleteMessageMSTeams(
  params: DeleteMSTeamsMessageParams,
): Promise<DeleteMSTeamsMessageResult> {
  const { cfg, to, activityId } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  log.debug?.("deleting proactive message", { activityId, conversationId });

  const baseRef = buildConversationReference(ref);
  const proactiveRef = { ...baseRef, activityId: undefined };

  try {
    await adapter.continueConversation(appId, proactiveRef, async (ctx) => {
      await ctx.deleteActivity(activityId);
    });
  } catch (error) {
    const classification = classifyMSTeamsSendError(error);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `msteams delete failed${status}: ${formatUnknownError(error)}${hint ? ` (${hint})` : ""}`,
      { cause: error },
    );
  }

  log.info("deleted proactive message", { activityId, conversationId });

  return { conversationId };
}

/**
 * List all known conversation references (for debugging/CLI).
 */
export async function listMSTeamsConversations(): Promise<
  {
    conversationId: string;
    userName?: string;
    conversationType?: string;
  }[]
> {
  const store = createMSTeamsConversationStoreFs();
  const all = await store.list();
  return all.map(({ conversationId, reference }) => ({
    conversationId,
    conversationType: reference.conversation?.conversationType,
    userName: reference.user?.name,
  }));
}
