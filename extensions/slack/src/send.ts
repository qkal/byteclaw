import type { Block, KnownBlock, WebClient } from "@slack/web-api";
import { type OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import {
  chunkMarkdownTextWithMode,
  isSilentReplyText,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { resolveTextChunksWithFallback } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { SlackTokenSource } from "./accounts.js";
import { resolveSlackAccount } from "./accounts.js";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";
import { validateSlackBlocksArray } from "./blocks-input.js";
import { createSlackWriteClient } from "./client.js";
import { markdownToSlackMrkdwnChunks } from "./format.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { loadOutboundMediaFromUrl } from "./runtime-api.js";
import { parseSlackTarget } from "./targets.js";
import { resolveSlackBotToken } from "./token.js";
const SLACK_UPLOAD_SSRF_POLICY = {
  allowRfc2544BenchmarkRange: true,
  allowedHostnames: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
};
const SLACK_DM_CHANNEL_CACHE_MAX = 1024;
const slackDmChannelCache = new Map<string, string>();

type SlackRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

export interface SlackSendIdentity {
  username?: string;
  iconUrl?: string;
  iconEmoji?: string;
}

interface SlackSendOpts {
  cfg?: OpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  uploadFileName?: string;
  uploadTitle?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  client?: WebClient;
  threadTs?: string;
  identity?: SlackSendIdentity;
  blocks?: (Block | KnownBlock)[];
}

function hasCustomIdentity(identity?: SlackSendIdentity): boolean {
  return Boolean(identity?.username || identity?.iconUrl || identity?.iconEmoji);
}

function isSlackCustomizeScopeError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const maybeData = err as Error & {
    data?: {
      error?: string;
      needed?: string;
      response_metadata?: { scopes?: string[]; acceptedScopes?: string[] };
    };
  };
  const code = normalizeLowercaseStringOrEmpty(maybeData.data?.error);
  if (code !== "missing_scope") {
    return false;
  }
  const needed = normalizeLowercaseStringOrEmpty(maybeData.data?.needed);
  if (needed?.includes("chat:write.customize")) {
    return true;
  }
  const scopes = [
    ...(maybeData.data?.response_metadata?.scopes ?? []),
    ...(maybeData.data?.response_metadata?.acceptedScopes ?? []),
  ].map((scope) => normalizeLowercaseStringOrEmpty(scope));
  return scopes.includes("chat:write.customize");
}

async function postSlackMessageBestEffort(params: {
  client: WebClient;
  channelId: string;
  text: string;
  threadTs?: string;
  identity?: SlackSendIdentity;
  blocks?: (Block | KnownBlock)[];
}) {
  const basePayload = {
    channel: params.channelId,
    text: params.text,
    thread_ts: params.threadTs,
    ...(params.blocks?.length ? { blocks: params.blocks } : {}),
  };
  try {
    // Slack Web API types model icon_url and icon_emoji as mutually exclusive.
    // Build payloads in explicit branches so TS and runtime stay aligned.
    if (params.identity?.iconUrl) {
      return await params.client.chat.postMessage({
        ...basePayload,
        ...(params.identity.username ? { username: params.identity.username } : {}),
        icon_url: params.identity.iconUrl,
      });
    }
    if (params.identity?.iconEmoji) {
      return await params.client.chat.postMessage({
        ...basePayload,
        ...(params.identity.username ? { username: params.identity.username } : {}),
        icon_emoji: params.identity.iconEmoji,
      });
    }
    return await params.client.chat.postMessage({
      ...basePayload,
      ...(params.identity?.username ? { username: params.identity.username } : {}),
    });
  } catch (error) {
    if (!hasCustomIdentity(params.identity) || !isSlackCustomizeScopeError(error)) {
      throw error;
    }
    logVerbose("slack send: missing chat:write.customize, retrying without custom identity");
    return params.client.chat.postMessage(basePayload);
  }
}

export interface SlackSendResult {
  messageId: string;
  channelId: string;
}

function resolveToken(params: {
  explicit?: string;
  accountId: string;
  fallbackToken?: string;
  fallbackSource?: SlackTokenSource;
}) {
  const explicit = resolveSlackBotToken(params.explicit);
  if (explicit) {
    return explicit;
  }
  const fallback = resolveSlackBotToken(params.fallbackToken);
  if (!fallback) {
    logVerbose(
      `slack send: missing bot token for account=${params.accountId} explicit=${Boolean(
        params.explicit,
      )} source=${params.fallbackSource ?? "unknown"}`,
    );
    throw new Error(
      `Slack bot token missing for account "${params.accountId}" (set channels.slack.accounts.${params.accountId}.botToken or SLACK_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

function parseRecipient(raw: string): SlackRecipient {
  const target = parseSlackTarget(raw);
  if (!target) {
    throw new Error("Recipient is required for Slack sends");
  }
  return { id: target.id, kind: target.kind };
}

function createSlackDmCacheKey(params: {
  accountId?: string;
  token: string;
  recipientId: string;
}): string {
  return `${params.accountId ?? "default"}:${params.token}:${params.recipientId}`;
}

function setSlackDmChannelCache(key: string, channelId: string): void {
  if (slackDmChannelCache.has(key)) {
    slackDmChannelCache.delete(key);
  } else if (slackDmChannelCache.size >= SLACK_DM_CHANNEL_CACHE_MAX) {
    const oldest = slackDmChannelCache.keys().next().value;
    if (oldest) {
      slackDmChannelCache.delete(oldest);
    }
  }
  slackDmChannelCache.set(key, channelId);
}

async function resolveChannelId(
  client: WebClient,
  recipient: SlackRecipient,
  params: { accountId?: string; token: string },
): Promise<{ channelId: string; isDm?: boolean; cacheHit?: boolean }> {
  // Bare Slack user IDs (U-prefix) may arrive with kind="channel" when the
  // Target string had no explicit prefix (parseSlackTarget defaults bare IDs
  // To "channel"). chat.postMessage tolerates user IDs directly, but
  // Files.uploadV2 → completeUploadExternal validates channel_id against
  // ^[CGDZ][A-Z0-9]{8,}$ and rejects U-prefixed IDs.  Always resolve user
  // IDs via conversations.open to obtain the DM channel ID.
  const isUserId = recipient.kind === "user" || /^U[A-Z0-9]+$/i.test(recipient.id);
  if (!isUserId) {
    return { channelId: recipient.id };
  }
  const cacheKey = createSlackDmCacheKey({
    accountId: params.accountId,
    recipientId: recipient.id,
    token: params.token,
  });
  const cachedChannelId = slackDmChannelCache.get(cacheKey);
  if (cachedChannelId) {
    return { cacheHit: true, channelId: cachedChannelId, isDm: true };
  }
  const response = await client.conversations.open({ users: recipient.id });
  const channelId = response.channel?.id;
  if (!channelId) {
    throw new Error("Failed to open Slack DM channel");
  }
  setSlackDmChannelCache(cacheKey, channelId);
  return { cacheHit: false, channelId, isDm: true };
}

export function clearSlackDmChannelCache(): void {
  slackDmChannelCache.clear();
}

async function uploadSlackFile(params: {
  client: WebClient;
  channelId: string;
  mediaUrl: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  uploadFileName?: string;
  uploadTitle?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  caption?: string;
  threadTs?: string;
  maxBytes?: number;
}): Promise<string> {
  const { buffer, contentType, fileName } = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: params.maxBytes,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  });
  const uploadFileName = params.uploadFileName ?? fileName ?? "upload";
  const uploadTitle = params.uploadTitle ?? uploadFileName;
  // Use the 3-step upload flow (getUploadURLExternal -> POST -> completeUploadExternal)
  // Instead of files.uploadV2 which relies on the deprecated files.upload endpoint
  // And can fail with missing_scope even when files:write is granted.
  const uploadUrlResp = await params.client.files.getUploadURLExternal({
    filename: uploadFileName,
    length: buffer.length,
  });
  if (!uploadUrlResp.ok || !uploadUrlResp.upload_url || !uploadUrlResp.file_id) {
    throw new Error(`Failed to get upload URL: ${uploadUrlResp.error ?? "unknown error"}`);
  }

  // Upload the file content to the presigned URL
  const uploadBody = new Uint8Array(buffer) as BodyInit;
  const { response: uploadResp, release } = await fetchWithSsrFGuard(
    withTrustedEnvProxyGuardedFetchMode({
      auditContext: "slack-upload-file",
      init: {
        method: "POST",
        ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
        body: uploadBody,
      },
      policy: SLACK_UPLOAD_SSRF_POLICY,
      url: uploadUrlResp.upload_url,
    }),
  );
  try {
    if (!uploadResp.ok) {
      throw new Error(`Failed to upload file: HTTP ${uploadResp.status}`);
    }
  } finally {
    await release();
  }

  // Complete the upload and share to channel/thread
  const completeResp = await params.client.files.completeUploadExternal({
    channel_id: params.channelId,
    files: [{ id: uploadUrlResp.file_id, title: uploadTitle }],
    ...(params.caption ? { initial_comment: params.caption } : {}),
    ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
  });
  if (!completeResp.ok) {
    throw new Error(`Failed to complete upload: ${completeResp.error ?? "unknown error"}`);
  }

  return uploadUrlResp.file_id;
}

export async function sendMessageSlack(
  to: string,
  message: string,
  opts: SlackSendOpts = {},
): Promise<SlackSendResult> {
  const trimmedMessage = normalizeOptionalString(message) ?? "";
  if (isSilentReplyText(trimmedMessage) && !opts.mediaUrl && !opts.blocks) {
    logVerbose("slack send: suppressed NO_REPLY token before API call");
    return { channelId: "", messageId: "suppressed" };
  }
  const blocks = opts.blocks == null ? undefined : validateSlackBlocksArray(opts.blocks);
  if (!trimmedMessage && !opts.mediaUrl && !blocks) {
    throw new Error("Slack send requires text, blocks, or media");
  }
  const cfg = opts.cfg ?? loadConfig();
  const account = resolveSlackAccount({
    accountId: opts.accountId,
    cfg,
  });
  const token = resolveToken({
    accountId: account.accountId,
    explicit: opts.token,
    fallbackSource: account.botTokenSource,
    fallbackToken: account.botToken,
  });
  const client = opts.client ?? createSlackWriteClient(token);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(client, recipient, {
    accountId: account.accountId,
    token,
  });
  if (blocks) {
    if (opts.mediaUrl) {
      throw new Error("Slack send does not support blocks with mediaUrl");
    }
    const fallbackText = trimmedMessage || buildSlackBlocksFallbackText(blocks);
    const response = await postSlackMessageBestEffort({
      blocks,
      channelId,
      client,
      identity: opts.identity,
      text: fallbackText,
      threadTs: opts.threadTs,
    });
    return {
      channelId,
      messageId: response.ts ?? "unknown",
    };
  }
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId, {
    fallbackLimit: SLACK_TEXT_LIMIT,
  });
  const chunkLimit = Math.min(textLimit, SLACK_TEXT_LIMIT);
  const tableMode = resolveMarkdownTableMode({
    accountId: account.accountId,
    cfg,
    channel: "slack",
  });
  const chunkMode = resolveChunkMode(cfg, "slack", account.accountId);
  const markdownChunks =
    chunkMode === "newline"
      ? chunkMarkdownTextWithMode(trimmedMessage, chunkLimit, chunkMode)
      : [trimmedMessage];
  const chunks = markdownChunks.flatMap((markdown) =>
    markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode }),
  );
  const resolvedChunks = resolveTextChunksWithFallback(trimmedMessage, chunks);
  const mediaMaxBytes =
    typeof account.config.mediaMaxMb === "number"
      ? account.config.mediaMaxMb * 1024 * 1024
      : undefined;

  let lastMessageId = "";
  if (opts.mediaUrl) {
    const [firstChunk, ...rest] = resolvedChunks;
    lastMessageId = await uploadSlackFile({
      caption: firstChunk,
      channelId,
      client,
      maxBytes: mediaMaxBytes,
      mediaAccess: opts.mediaAccess,
      mediaLocalRoots: opts.mediaLocalRoots,
      mediaReadFile: opts.mediaReadFile,
      mediaUrl: opts.mediaUrl,
      threadTs: opts.threadTs,
      uploadFileName: opts.uploadFileName,
      uploadTitle: opts.uploadTitle,
    });
    for (const chunk of rest) {
      const response = await postSlackMessageBestEffort({
        channelId,
        client,
        identity: opts.identity,
        text: chunk,
        threadTs: opts.threadTs,
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
  } else {
    for (const chunk of resolvedChunks.length ? resolvedChunks : [""]) {
      const response = await postSlackMessageBestEffort({
        channelId,
        client,
        identity: opts.identity,
        text: chunk,
        threadTs: opts.threadTs,
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
  }

  return {
    channelId,
    messageId: lastMessageId || "unknown",
  };
}
