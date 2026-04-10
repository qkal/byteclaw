import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { getMSTeamsRuntime } from "../runtime.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import {
  type MSTeamsAttachmentFetchPolicy,
  extractInlineImageCandidates,
  inferPlaceholder,
  isDownloadableAttachment,
  isRecord,
  isUrlAllowed,
  normalizeContentType,
  resolveAttachmentFetchPolicy,
  resolveMediaSsrfPolicy,
  resolveRequestUrl,
  safeFetchWithPolicy,
  tryBuildGraphSharesUrlForSharedLink,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsInboundMedia,
} from "./types.js";

interface DownloadCandidate {
  url: string;
  fileHint?: string;
  contentTypeHint?: string;
  placeholder: string;
}

function resolveDownloadCandidate(att: MSTeamsAttachmentLike): DownloadCandidate | null {
  const contentType = normalizeContentType(att.contentType);
  const name = normalizeOptionalString(att.name) ?? "";

  if (contentType === "application/vnd.microsoft.teams.file.download.info") {
    if (!isRecord(att.content)) {
      return null;
    }
    const downloadUrl = normalizeOptionalString(att.content.downloadUrl) ?? "";
    if (!downloadUrl) {
      return null;
    }

    const fileType = normalizeOptionalString(att.content.fileType) ?? "";
    const uniqueId = normalizeOptionalString(att.content.uniqueId) ?? "";
    const fileName = normalizeOptionalString(att.content.fileName) ?? "";

    const fileHint = name || fileName || (uniqueId && fileType ? `${uniqueId}.${fileType}` : "");
    return {
      contentTypeHint: undefined,
      fileHint: fileHint || undefined,
      placeholder: inferPlaceholder({
        contentType,
        fileName: fileHint,
        fileType,
      }),
      url: downloadUrl,
    };
  }

  const contentUrl = normalizeOptionalString(att.contentUrl) ?? "";
  if (!contentUrl) {
    return null;
  }

  // OneDrive/SharePoint shared links (delivered in 1:1 DMs when the user
  // Picks "Attach > OneDrive") cannot be fetched directly — the URL returns
  // An HTML landing page rather than the file bytes. Rewrite them to the
  // Graph shares endpoint so the auth fallback attaches a Graph-scoped token
  // And the response is the real file content.
  const sharesUrl = tryBuildGraphSharesUrlForSharedLink(contentUrl);
  const resolvedUrl = sharesUrl ?? contentUrl;
  // Graph shares returns raw bytes without a declared content type we can
  // Trust for routing — let the downloader infer MIME from the buffer.
  const resolvedContentTypeHint = sharesUrl ? undefined : contentType;

  return {
    contentTypeHint: resolvedContentTypeHint,
    fileHint: name || undefined,
    placeholder: inferPlaceholder({ contentType, fileName: name }),
    url: resolvedUrl,
  };
}

function scopeCandidatesForUrl(url: string): string[] {
  try {
    const host = normalizeLowercaseStringOrEmpty(new URL(url).hostname);
    const looksLikeGraph =
      host.endsWith("graph.microsoft.com") ||
      host.endsWith("sharepoint.com") ||
      host.endsWith("1drv.ms") ||
      host.includes("sharepoint");
    return looksLikeGraph
      ? ["https://graph.microsoft.com", "https://api.botframework.com"]
      : ["https://api.botframework.com", "https://graph.microsoft.com"];
  } catch {
    return ["https://api.botframework.com", "https://graph.microsoft.com"];
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithAuthFallback(params: {
  url: string;
  tokenProvider?: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
  requestInit?: RequestInit;
  policy: MSTeamsAttachmentFetchPolicy;
}): Promise<Response> {
  const firstAttempt = await safeFetchWithPolicy({
    fetchFn: params.fetchFn,
    policy: params.policy,
    requestInit: params.requestInit,
    url: params.url,
  });
  if (firstAttempt.ok) {
    return firstAttempt;
  }
  if (!params.tokenProvider) {
    return firstAttempt;
  }
  if (firstAttempt.status !== 401 && firstAttempt.status !== 403) {
    return firstAttempt;
  }
  if (!isUrlAllowed(params.url, params.policy.authAllowHosts)) {
    return firstAttempt;
  }

  const scopes = scopeCandidatesForUrl(params.url);
  const fetchFn = params.fetchFn ?? fetch;
  for (const scope of scopes) {
    try {
      const token = await params.tokenProvider.getAccessToken(scope);
      const authHeaders = new Headers(params.requestInit?.headers);
      authHeaders.set("Authorization", `Bearer ${token}`);
      const authAttempt = await safeFetchWithPolicy({
        fetchFn,
        policy: params.policy,
        requestInit: {
          ...params.requestInit,
          headers: authHeaders,
        },
        url: params.url,
      });
      if (authAttempt.ok) {
        return authAttempt;
      }
      if (isRedirectStatus(authAttempt.status)) {
        // Redirects in guarded fetch mode must propagate to the outer guard.
        return authAttempt;
      }
      if (authAttempt.status !== 401 && authAttempt.status !== 403) {
        // Preserve scope fallback semantics for non-auth failures.
        continue;
      }
    } catch {
      // Try the next scope.
    }
  }

  return firstAttempt;
}

/**
 * Download all file attachments from a Teams message (images, documents, etc.).
 * Renamed from downloadMSTeamsImageAttachments to support all file types.
 */
export async function downloadMSTeamsAttachments(params: {
  attachments: MSTeamsAttachmentLike[] | undefined;
  maxBytes: number;
  tokenProvider?: MSTeamsAccessTokenProvider;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
}): Promise<MSTeamsInboundMedia[]> {
  const list = Array.isArray(params.attachments) ? params.attachments : [];
  if (list.length === 0) {
    return [];
  }
  const policy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const { allowHosts } = policy;
  const ssrfPolicy = resolveMediaSsrfPolicy(allowHosts);

  // Download ANY downloadable attachment (not just images)
  const downloadable = list.filter(isDownloadableAttachment);
  const candidates: DownloadCandidate[] = downloadable
    .map(resolveDownloadCandidate)
    .filter(Boolean) as DownloadCandidate[];

  const inlineCandidates = extractInlineImageCandidates(list, {
    maxInlineBytes: params.maxBytes,
    maxInlineTotalBytes: params.maxBytes,
  });

  const seenUrls = new Set<string>();
  for (const inline of inlineCandidates) {
    if (inline.kind === "url") {
      if (!isUrlAllowed(inline.url, allowHosts)) {
        continue;
      }
      if (seenUrls.has(inline.url)) {
        continue;
      }
      seenUrls.add(inline.url);
      candidates.push({
        contentTypeHint: inline.contentType,
        fileHint: inline.fileHint,
        placeholder: inline.placeholder,
        url: inline.url,
      });
    }
  }
  if (candidates.length === 0 && inlineCandidates.length === 0) {
    return [];
  }

  const out: MSTeamsInboundMedia[] = [];
  for (const inline of inlineCandidates) {
    if (inline.kind !== "data") {
      continue;
    }
    if (inline.data.byteLength > params.maxBytes) {
      continue;
    }
    try {
      // Data inline candidates (base64 data URLs) don't have original filenames
      const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
        inline.data,
        inline.contentType,
        "inbound",
        params.maxBytes,
      );
      out.push({
        contentType: saved.contentType,
        path: saved.path,
        placeholder: inline.placeholder,
      });
    } catch {
      // Ignore decode failures and continue.
    }
  }
  for (const candidate of candidates) {
    if (!isUrlAllowed(candidate.url, allowHosts)) {
      continue;
    }
    try {
      const media = await downloadAndStoreMSTeamsRemoteMedia({
        contentTypeHint: candidate.contentTypeHint,
        fetchImpl: (input, init) =>
          fetchWithAuthFallback({
            fetchFn: params.fetchFn,
            policy,
            requestInit: init,
            tokenProvider: params.tokenProvider,
            url: resolveRequestUrl(input),
          }),
        filePathHint: candidate.fileHint ?? candidate.url,
        maxBytes: params.maxBytes,
        placeholder: candidate.placeholder,
        preserveFilenames: params.preserveFilenames,
        ssrfPolicy,
        url: candidate.url,
      });
      out.push(media);
    } catch {
      // Ignore download failures and continue with next candidate.
    }
  }
  return out;
}

/**
 * @deprecated Use `downloadMSTeamsAttachments` instead (supports all file types).
 */
export const downloadMSTeamsImageAttachments = downloadMSTeamsAttachments;
