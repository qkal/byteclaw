import {
  type MSTeamsAccessTokenProvider,
  type MSTeamsAttachmentLike,
  type MSTeamsHtmlAttachmentSummary,
  type MSTeamsInboundMedia,
  buildMSTeamsGraphMessageUrls,
  downloadMSTeamsAttachments,
  downloadMSTeamsBotFrameworkAttachments,
  downloadMSTeamsGraphMedia,
  extractMSTeamsHtmlAttachmentIds,
  isBotFrameworkPersonalChatId,
} from "../attachments.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

interface MSTeamsLogger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
}

export async function resolveMSTeamsInboundMedia(params: {
  attachments: MSTeamsAttachmentLike[];
  htmlSummary?: MSTeamsHtmlAttachmentSummary;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  tokenProvider: MSTeamsAccessTokenProvider;
  conversationType: string;
  conversationId: string;
  conversationMessageId?: string;
  serviceUrl?: string;
  activity: Pick<MSTeamsTurnContext["activity"], "id" | "replyToId" | "channelData">;
  log: MSTeamsLogger;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
}): Promise<MSTeamsInboundMedia[]> {
  const {
    attachments,
    htmlSummary,
    maxBytes,
    tokenProvider,
    allowHosts,
    conversationType,
    conversationId,
    conversationMessageId,
    serviceUrl,
    activity,
    log,
    preserveFilenames,
  } = params;

  let mediaList = await downloadMSTeamsAttachments({
    allowHosts,
    attachments,
    authAllowHosts: params.authAllowHosts,
    maxBytes,
    preserveFilenames,
    tokenProvider,
  });

  if (mediaList.length === 0) {
    const hasHtmlAttachment = attachments.some(
      (att) => typeof att.contentType === "string" && att.contentType.startsWith("text/html"),
    );

    // Personal DMs with the bot use Bot Framework conversation IDs (`a:...`
    // Or `8:orgid:...`) which Graph's `/chats/{id}` endpoint rejects with
    // "Invalid ThreadId". Fetch media via the Bot Framework v3 attachments
    // Endpoint instead, which speaks the same identifier space.
    if (hasHtmlAttachment && isBotFrameworkPersonalChatId(conversationId)) {
      if (!serviceUrl) {
        log.debug?.("bot framework attachment skipped (missing serviceUrl)", {
          conversationId,
          conversationType,
        });
      } else {
        const attachmentIds = extractMSTeamsHtmlAttachmentIds(attachments);
        if (attachmentIds.length === 0) {
          log.debug?.("bot framework attachment ids unavailable", {
            conversationId,
            conversationType,
          });
        } else {
          const bfMedia = await downloadMSTeamsBotFrameworkAttachments({
            allowHosts,
            attachmentIds,
            authAllowHosts: params.authAllowHosts,
            maxBytes,
            preserveFilenames,
            serviceUrl,
            tokenProvider,
          });
          if (bfMedia.media.length > 0) {
            mediaList = bfMedia.media;
          } else {
            log.debug?.("bot framework attachments fetch empty", {
              attachmentCount: bfMedia.attachmentCount ?? attachmentIds.length,
              conversationType,
            });
          }
        }
      }
    }

    if (
      hasHtmlAttachment &&
      mediaList.length === 0 &&
      !isBotFrameworkPersonalChatId(conversationId)
    ) {
      const messageUrls = buildMSTeamsGraphMessageUrls({
        channelData: activity.channelData,
        conversationId,
        conversationMessageId,
        conversationType,
        messageId: activity.id ?? undefined,
        replyToId: activity.replyToId ?? undefined,
      });
      if (messageUrls.length === 0) {
        log.debug?.("graph message url unavailable", {
          conversationType,
          hasChannelData: Boolean(activity.channelData),
          messageId: activity.id ?? undefined,
          replyToId: activity.replyToId ?? undefined,
        });
      } else {
        const attempts: {
          url: string;
          hostedStatus?: number;
          attachmentStatus?: number;
          hostedCount?: number;
          attachmentCount?: number;
          tokenError?: boolean;
        }[] = [];
        for (const messageUrl of messageUrls) {
          const graphMedia = await downloadMSTeamsGraphMedia({
            allowHosts,
            authAllowHosts: params.authAllowHosts,
            maxBytes,
            messageUrl,
            preserveFilenames,
            tokenProvider,
          });
          attempts.push({
            attachmentCount: graphMedia.attachmentCount,
            attachmentStatus: graphMedia.attachmentStatus,
            hostedCount: graphMedia.hostedCount,
            hostedStatus: graphMedia.hostedStatus,
            tokenError: graphMedia.tokenError,
            url: messageUrl,
          });
          if (graphMedia.media.length > 0) {
            mediaList = graphMedia.media;
            break;
          }
          if (graphMedia.tokenError) {
            break;
          }
        }
        if (mediaList.length === 0) {
          log.debug?.("graph media fetch empty", { attempts });
        }
      }
    }
  }

  if (mediaList.length > 0) {
    log.debug?.("downloaded attachments", { count: mediaList.length });
  } else if (htmlSummary?.imgTags) {
    log.debug?.("inline images detected but none downloaded", {
      cidImages: htmlSummary.cidImages,
      dataImages: htmlSummary.dataImages,
      imgTags: htmlSummary.imgTags,
      srcHosts: htmlSummary.srcHosts,
    });
  }

  return mediaList;
}
