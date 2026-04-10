import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { type SsrFPolicy, fetchWithSsrFGuard } from "../../runtime-api.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { ensureUserAgentHeader } from "../user-agent.js";
import { downloadMSTeamsAttachments } from "./download.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import {
  GRAPH_ROOT,
  type MSTeamsAttachmentFetchPolicy,
  applyAuthorizationHeaderForUrl,
  encodeGraphShareId,
  estimateBase64DecodedBytes,
  inferPlaceholder,
  isUrlAllowed,
  normalizeContentType,
  readNestedString,
  resolveAttachmentFetchPolicy,
  resolveMediaSsrfPolicy,
  resolveRequestUrl,
  safeFetchWithPolicy,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsGraphMediaResult,
  MSTeamsInboundMedia,
} from "./types.js";

interface GraphHostedContent {
  id?: string | null;
  contentType?: string | null;
  contentBytes?: string | null;
}

interface GraphAttachment {
  id?: string | null;
  contentType?: string | null;
  contentUrl?: string | null;
  name?: string | null;
  thumbnailUrl?: string | null;
  content?: unknown;
}

export function buildMSTeamsGraphMessageUrls(params: {
  conversationType?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  replyToId?: string | null;
  conversationMessageId?: string | null;
  channelData?: unknown;
}): string[] {
  const conversationType = normalizeLowercaseStringOrEmpty(params.conversationType ?? "");
  const messageIdCandidates = new Set<string>();
  const pushCandidate = (value: string | null | undefined) => {
    const trimmed = normalizeOptionalString(value) ?? "";
    if (trimmed) {
      messageIdCandidates.add(trimmed);
    }
  };

  pushCandidate(params.messageId);
  pushCandidate(params.conversationMessageId);
  pushCandidate(readNestedString(params.channelData, ["messageId"]));
  pushCandidate(readNestedString(params.channelData, ["teamsMessageId"]));

  const replyToId = normalizeOptionalString(params.replyToId) ?? "";

  if (conversationType === "channel") {
    const teamId =
      readNestedString(params.channelData, ["team", "id"]) ??
      readNestedString(params.channelData, ["teamId"]);
    const channelId =
      readNestedString(params.channelData, ["channel", "id"]) ??
      readNestedString(params.channelData, ["channelId"]) ??
      readNestedString(params.channelData, ["teamsChannelId"]);
    if (!teamId || !channelId) {
      return [];
    }
    const urls: string[] = [];
    if (replyToId) {
      for (const candidate of messageIdCandidates) {
        if (candidate === replyToId) {
          continue;
        }
        urls.push(
          `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(replyToId)}/replies/${encodeURIComponent(candidate)}`,
        );
      }
    }
    if (messageIdCandidates.size === 0 && replyToId) {
      messageIdCandidates.add(replyToId);
    }
    for (const candidate of messageIdCandidates) {
      urls.push(
        `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(candidate)}`,
      );
    }
    return [...new Set(urls)];
  }

  const chatId = params.conversationId?.trim() || readNestedString(params.channelData, ["chatId"]);
  if (!chatId) {
    return [];
  }
  if (messageIdCandidates.size === 0 && replyToId) {
    messageIdCandidates.add(replyToId);
  }
  const urls = [...messageIdCandidates].map(
    (candidate) =>
      `${GRAPH_ROOT}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(candidate)}`,
  );
  return [...new Set(urls)];
}

async function fetchGraphCollection<T>(params: {
  url: string;
  accessToken: string;
  fetchFn?: typeof fetch;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ status: number; items: T[] }> {
  const fetchFn = params.fetchFn ?? fetch;
  const { response, release } = await fetchWithSsrFGuard({
    auditContext: "msteams.graph.collection",
    fetchImpl: fetchFn,
    init: {
      headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }),
    },
    policy: params.ssrfPolicy,
    url: params.url,
  });
  try {
    const { status } = response;
    if (!response.ok) {
      return { items: [], status };
    }
    try {
      const data = (await response.json()) as { value?: T[] };
      return { items: Array.isArray(data.value) ? data.value : [], status };
    } catch {
      return { items: [], status };
    }
  } finally {
    await release();
  }
}

function normalizeGraphAttachment(att: GraphAttachment): MSTeamsAttachmentLike {
  let { content } = att;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      // Keep as raw string if it's not JSON.
    }
  }
  return {
    content,
    contentType: normalizeContentType(att.contentType) ?? undefined,
    contentUrl: att.contentUrl ?? undefined,
    name: att.name ?? undefined,
    thumbnailUrl: att.thumbnailUrl ?? undefined,
  };
}

/**
 * Download all hosted content from a Teams message (images, documents, etc.).
 * Renamed from downloadGraphHostedImages to support all file types.
 */
async function downloadGraphHostedContent(params: {
  accessToken: string;
  messageUrl: string;
  maxBytes: number;
  fetchFn?: typeof fetch;
  preserveFilenames?: boolean;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ media: MSTeamsInboundMedia[]; status: number; count: number }> {
  const hosted = await fetchGraphCollection<GraphHostedContent>({
    accessToken: params.accessToken,
    fetchFn: params.fetchFn,
    ssrfPolicy: params.ssrfPolicy,
    url: `${params.messageUrl}/hostedContents`,
  });
  if (hosted.items.length === 0) {
    return { count: 0, media: [], status: hosted.status };
  }

  const out: MSTeamsInboundMedia[] = [];
  for (const item of hosted.items) {
    const contentBytes = typeof item.contentBytes === "string" ? item.contentBytes : "";
    let buffer: Buffer;
    if (contentBytes) {
      if (estimateBase64DecodedBytes(contentBytes) > params.maxBytes) {
        continue;
      }
      try {
        buffer = Buffer.from(contentBytes, "base64");
      } catch {
        continue;
      }
    } else if (item.id) {
      // ContentBytes not inline — fetch from the individual $value endpoint.
      try {
        const valueUrl = `${params.messageUrl}/hostedContents/${encodeURIComponent(item.id)}/$value`;
        const { response: valRes, release } = await fetchWithSsrFGuard({
          auditContext: "msteams.graph.hostedContent.value",
          fetchImpl: params.fetchFn ?? fetch,
          init: {
            headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }),
          },
          policy: params.ssrfPolicy,
          url: valueUrl,
        });
        try {
          if (!valRes.ok) {
            continue;
          }
          // Check Content-Length before buffering to avoid RSS spikes on large files.
          const cl = valRes.headers.get("content-length");
          if (cl && Number(cl) > params.maxBytes) {
            continue;
          }
          const ab = await valRes.arrayBuffer();
          buffer = Buffer.from(ab);
        } finally {
          await release();
        }
      } catch {
        continue;
      }
    } else {
      continue;
    }
    if (buffer.byteLength > params.maxBytes) {
      continue;
    }
    const mime = await getMSTeamsRuntime().media.detectMime({
      buffer,
      headerMime: item.contentType ?? undefined,
    });
    // Download any file type, not just images
    try {
      const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
        buffer,
        mime ?? item.contentType ?? undefined,
        "inbound",
        params.maxBytes,
      );
      out.push({
        contentType: saved.contentType,
        path: saved.path,
        placeholder: inferPlaceholder({ contentType: saved.contentType }),
      });
    } catch {
      // Ignore save failures.
    }
  }

  return { count: hosted.items.length, media: out, status: hosted.status };
}

export async function downloadMSTeamsGraphMedia(params: {
  messageUrl?: string | null;
  tokenProvider?: MSTeamsAccessTokenProvider;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
}): Promise<MSTeamsGraphMediaResult> {
  if (!params.messageUrl || !params.tokenProvider) {
    return { media: [] };
  }
  const policy: MSTeamsAttachmentFetchPolicy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const ssrfPolicy = resolveMediaSsrfPolicy(policy.allowHosts);
  const { messageUrl } = params;
  let accessToken: string;
  try {
    accessToken = await params.tokenProvider.getAccessToken("https://graph.microsoft.com");
  } catch {
    return { media: [], messageUrl, tokenError: true };
  }

  // Fetch the full message to get SharePoint file attachments (for group chats)
  const fetchFn = params.fetchFn ?? fetch;
  const sharePointMedia: MSTeamsInboundMedia[] = [];
  const downloadedReferenceUrls = new Set<string>();
  try {
    const { response: msgRes, release } = await fetchWithSsrFGuard({
      auditContext: "msteams.graph.message",
      fetchImpl: fetchFn,
      init: {
        headers: ensureUserAgentHeader({ Authorization: `Bearer ${accessToken}` }),
      },
      policy: ssrfPolicy,
      url: messageUrl,
    });
    try {
      if (msgRes.ok) {
        const msgData = (await msgRes.json()) as {
          body?: { content?: string; contentType?: string };
          attachments?: {
            id?: string;
            contentUrl?: string;
            contentType?: string;
            name?: string;
          }[];
        };

        // Extract SharePoint file attachments (contentType: "reference")
        // Download any file type, not just images
        const spAttachments = (msgData.attachments ?? []).filter(
          (a) => a.contentType === "reference" && a.contentUrl && a.name,
        );
        for (const att of spAttachments) {
          const name = att.name ?? "file";

          try {
            // SharePoint URLs need to be accessed via Graph shares API. Validate the
            // Rewritten Graph URL, not the original SharePoint host, so the existing
            // Graph allowlist path can fetch shared files without separately allowing
            // Arbitrary SharePoint hosts.
            const shareUrl = att.contentUrl!;
            const sharesUrl = `${GRAPH_ROOT}/shares/${encodeGraphShareId(shareUrl)}/driveItem/content`;
            if (!isUrlAllowed(sharesUrl, policy.allowHosts)) {
              continue;
            }

            const media = await downloadAndStoreMSTeamsRemoteMedia({
              contentTypeHint: "application/octet-stream",
              fetchImpl: async (input, init) => {
                const requestUrl = resolveRequestUrl(input);
                const headers = ensureUserAgentHeader(init?.headers);
                applyAuthorizationHeaderForUrl({
                  authAllowHosts: policy.authAllowHosts,
                  bearerToken: accessToken,
                  headers,
                  url: requestUrl,
                });
                return await safeFetchWithPolicy({
                  fetchFn,
                  policy,
                  requestInit: {
                    ...init,
                    headers,
                  },
                  url: requestUrl,
                });
              },
              filePathHint: name,
              maxBytes: params.maxBytes,
              preserveFilenames: params.preserveFilenames,
              ssrfPolicy,
              url: sharesUrl,
            });
            sharePointMedia.push(media);
            downloadedReferenceUrls.add(shareUrl);
          } catch {
            // Ignore SharePoint download failures.
          }
        }
      }
    } finally {
      await release();
    }
  } catch {
    // Ignore message fetch failures.
  }

  const hosted = await downloadGraphHostedContent({
    accessToken,
    fetchFn: params.fetchFn,
    maxBytes: params.maxBytes,
    messageUrl,
    preserveFilenames: params.preserveFilenames,
    ssrfPolicy,
  });

  const attachments = await fetchGraphCollection<GraphAttachment>({
    accessToken,
    fetchFn: params.fetchFn,
    ssrfPolicy,
    url: `${messageUrl}/attachments`,
  });

  const normalizedAttachments = attachments.items.map(normalizeGraphAttachment);
  const filteredAttachments =
    sharePointMedia.length > 0
      ? normalizedAttachments.filter((att) => {
          const contentType = normalizeOptionalLowercaseString(att.contentType);
          if (contentType !== "reference") {
            return true;
          }
          const url = typeof att.contentUrl === "string" ? att.contentUrl : "";
          if (!url) {
            return true;
          }
          return !downloadedReferenceUrls.has(url);
        })
      : normalizedAttachments;
  const attachmentMedia = await downloadMSTeamsAttachments({
    allowHosts: policy.allowHosts,
    attachments: filteredAttachments,
    authAllowHosts: policy.authAllowHosts,
    fetchFn: params.fetchFn,
    maxBytes: params.maxBytes,
    preserveFilenames: params.preserveFilenames,
    tokenProvider: params.tokenProvider,
  });

  return {
    attachmentCount: filteredAttachments.length + sharePointMedia.length,
    attachmentStatus: attachments.status,
    hostedCount: hosted.count,
    hostedStatus: hosted.status,
    media: [...sharePointMedia, ...hosted.media, ...attachmentMedia],
    messageUrl,
  };
}
