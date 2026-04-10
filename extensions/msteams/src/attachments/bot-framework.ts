import { Buffer } from "node:buffer";
import { type SsrFPolicy, fetchWithSsrFGuard } from "../../runtime-api.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { ensureUserAgentHeader } from "../user-agent.js";
import {
  type MSTeamsAttachmentFetchPolicy,
  inferPlaceholder,
  isUrlAllowed,
  resolveAttachmentFetchPolicy,
  resolveMediaSsrfPolicy,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsGraphMediaResult,
  MSTeamsInboundMedia,
} from "./types.js";

/**
 * Bot Framework Service token scope for requesting a token used against
 * the Bot Connector (v3) REST endpoints such as `/v3/attachments/{id}`.
 */
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com";

/**
 * Detect Bot Framework personal chat ("a:") and MSA orgid ("8:orgid:") conversation
 * IDs. These identifiers are not recognized by Graph's `/chats/{id}` endpoint, so we
 * must fetch media via the Bot Framework v3 attachments endpoint instead.
 *
 * Graph-compatible IDs start with `19:` and are left untouched by this detector.
 */
export function isBotFrameworkPersonalChatId(conversationId: string | null | undefined): boolean {
  if (typeof conversationId !== "string") {
    return false;
  }
  const trimmed = conversationId.trim();
  return trimmed.startsWith("a:") || trimmed.startsWith("8:orgid:");
}

interface BotFrameworkView {
  viewId?: string | null;
  size?: number | null;
}

interface BotFrameworkAttachmentInfo {
  name?: string | null;
  type?: string | null;
  views?: BotFrameworkView[] | null;
}

function normalizeServiceUrl(serviceUrl: string): string {
  // Bot Framework service URLs sometimes carry a trailing slash; normalize so
  // We can safely append `/v3/attachments/...` below.
  return serviceUrl.replace(/\/+$/, "");
}

async function fetchBotFrameworkAttachmentInfo(params: {
  serviceUrl: string;
  attachmentId: string;
  accessToken: string;
  fetchFn?: typeof fetch;
  ssrfPolicy?: SsrFPolicy;
}): Promise<BotFrameworkAttachmentInfo | undefined> {
  const url = `${normalizeServiceUrl(params.serviceUrl)}/v3/attachments/${encodeURIComponent(params.attachmentId)}`;
  const { response, release } = await fetchWithSsrFGuard({
    auditContext: "msteams.botframework.attachmentInfo",
    fetchImpl: params.fetchFn ?? fetch,
    init: {
      headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }),
    },
    policy: params.ssrfPolicy,
    url,
  });
  try {
    if (!response.ok) {
      return undefined;
    }
    try {
      return (await response.json()) as BotFrameworkAttachmentInfo;
    } catch {
      return undefined;
    }
  } finally {
    await release();
  }
}

async function fetchBotFrameworkAttachmentView(params: {
  serviceUrl: string;
  attachmentId: string;
  viewId: string;
  accessToken: string;
  maxBytes: number;
  fetchFn?: typeof fetch;
  ssrfPolicy?: SsrFPolicy;
}): Promise<Buffer | undefined> {
  const url = `${normalizeServiceUrl(params.serviceUrl)}/v3/attachments/${encodeURIComponent(params.attachmentId)}/views/${encodeURIComponent(params.viewId)}`;
  const { response, release } = await fetchWithSsrFGuard({
    auditContext: "msteams.botframework.attachmentView",
    fetchImpl: params.fetchFn ?? fetch,
    init: {
      headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }),
    },
    policy: params.ssrfPolicy,
    url,
  });
  try {
    if (!response.ok) {
      return undefined;
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > params.maxBytes) {
      return undefined;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > params.maxBytes) {
      return undefined;
    }
    return buffer;
  } finally {
    await release();
  }
}

/**
 * Download media for a single attachment via the Bot Framework v3 attachments
 * endpoint. Used for personal DM conversations where the Graph `/chats/{id}`
 * path is not usable because the Bot Framework conversation ID (`a:...`) is
 * not a valid Graph chat identifier.
 */
export async function downloadMSTeamsBotFrameworkAttachment(params: {
  serviceUrl: string;
  attachmentId: string;
  tokenProvider?: MSTeamsAccessTokenProvider;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  fileNameHint?: string | null;
  contentTypeHint?: string | null;
  preserveFilenames?: boolean;
}): Promise<MSTeamsInboundMedia | undefined> {
  if (!params.serviceUrl || !params.attachmentId || !params.tokenProvider) {
    return undefined;
  }
  const policy: MSTeamsAttachmentFetchPolicy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const baseUrl = `${normalizeServiceUrl(params.serviceUrl)}/v3/attachments/${encodeURIComponent(params.attachmentId)}`;
  if (!isUrlAllowed(baseUrl, policy.allowHosts)) {
    return undefined;
  }
  const ssrfPolicy = resolveMediaSsrfPolicy(policy.allowHosts);

  let accessToken: string;
  try {
    accessToken = await params.tokenProvider.getAccessToken(BOT_FRAMEWORK_SCOPE);
  } catch {
    return undefined;
  }
  if (!accessToken) {
    return undefined;
  }

  const info = await fetchBotFrameworkAttachmentInfo({
    accessToken,
    attachmentId: params.attachmentId,
    fetchFn: params.fetchFn,
    serviceUrl: params.serviceUrl,
    ssrfPolicy,
  });
  if (!info) {
    return undefined;
  }

  const views = Array.isArray(info.views) ? info.views : [];
  // Prefer the "original" view when present, otherwise fall back to the first
  // View the Bot Framework service returned.
  const original = views.find((view) => view?.viewId === "original");
  const candidateView = original ?? views.find((view) => typeof view?.viewId === "string");
  const viewId =
    typeof candidateView?.viewId === "string" && candidateView.viewId
      ? candidateView.viewId
      : undefined;
  if (!viewId) {
    return undefined;
  }
  if (
    typeof candidateView?.size === "number" &&
    candidateView.size > 0 &&
    candidateView.size > params.maxBytes
  ) {
    return undefined;
  }

  const buffer = await fetchBotFrameworkAttachmentView({
    accessToken,
    attachmentId: params.attachmentId,
    fetchFn: params.fetchFn,
    maxBytes: params.maxBytes,
    serviceUrl: params.serviceUrl,
    ssrfPolicy,
    viewId,
  });
  if (!buffer) {
    return undefined;
  }

  const fileNameHint =
    (typeof params.fileNameHint === "string" && params.fileNameHint) ||
    (typeof info.name === "string" && info.name) ||
    undefined;
  const contentTypeHint =
    (typeof params.contentTypeHint === "string" && params.contentTypeHint) ||
    (typeof info.type === "string" && info.type) ||
    undefined;

  const mime = await getMSTeamsRuntime().media.detectMime({
    buffer,
    filePath: fileNameHint,
    headerMime: contentTypeHint,
  });

  try {
    const originalFilename = params.preserveFilenames ? fileNameHint : undefined;
    const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
      buffer,
      mime ?? contentTypeHint,
      "inbound",
      params.maxBytes,
      originalFilename,
    );
    return {
      contentType: saved.contentType,
      path: saved.path,
      placeholder: inferPlaceholder({ contentType: saved.contentType, fileName: fileNameHint }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Download media for every attachment referenced by a Bot Framework personal
 * chat activity. Returns all successfully fetched media along with diagnostics
 * compatible with `downloadMSTeamsGraphMedia`'s result shape so callers can
 * reuse the existing logging path.
 */
export async function downloadMSTeamsBotFrameworkAttachments(params: {
  serviceUrl: string;
  attachmentIds: string[];
  tokenProvider?: MSTeamsAccessTokenProvider;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  fileNameHint?: string | null;
  contentTypeHint?: string | null;
  preserveFilenames?: boolean;
}): Promise<MSTeamsGraphMediaResult> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of params.attachmentIds ?? []) {
    if (typeof id !== "string") {
      continue;
    }
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  if (unique.length === 0 || !params.serviceUrl || !params.tokenProvider) {
    return { attachmentCount: unique.length, media: [] };
  }

  const media: MSTeamsInboundMedia[] = [];
  for (const attachmentId of unique) {
    try {
      const item = await downloadMSTeamsBotFrameworkAttachment({
        allowHosts: params.allowHosts,
        attachmentId,
        authAllowHosts: params.authAllowHosts,
        contentTypeHint: params.contentTypeHint,
        fetchFn: params.fetchFn,
        fileNameHint: params.fileNameHint,
        maxBytes: params.maxBytes,
        preserveFilenames: params.preserveFilenames,
        serviceUrl: params.serviceUrl,
        tokenProvider: params.tokenProvider,
      });
      if (item) {
        media.push(item);
      }
    } catch {
      // Ignore per-attachment failures and continue.
    }
  }

  return {
    attachmentCount: unique.length,
    media,
  };
}
