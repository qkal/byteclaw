import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type MessagePayloadObject, type RequestClient, serializePayload } from "@buape/carbon";
import { ChannelType, Routes } from "discord-api-types/v10";
import { type OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { maxBytesForKind } from "openclaw/plugin-sdk/media-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-runtime";
import { unlinkIfExists } from "openclaw/plugin-sdk/media-runtime";
import type { PollInput } from "openclaw/plugin-sdk/media-runtime";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { convertMarkdownTables, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { resolveDiscordAccount } from "./accounts.js";
import { resolveDiscordClientAccountContext } from "./client.js";
import { rewriteDiscordKnownMentions } from "./mentions.js";
import { parseAndResolveRecipient } from "./recipient-resolution.js";
import {
  type DiscordSendComponents,
  type DiscordSendEmbeds,
  SUPPRESS_NOTIFICATIONS_FLAG,
  buildDiscordMessagePayload,
  buildDiscordSendError,
  buildDiscordTextChunks,
  createDiscordClient,
  normalizeDiscordPollInput,
  normalizeStickerIds,
  resolveChannelId,
  resolveDiscordChannelType,
  resolveDiscordSendComponents,
  resolveDiscordSendEmbeds,
  sendDiscordMedia,
  sendDiscordText,
  stripUndefinedFields,
} from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
import {
  ensureOggOpus,
  getVoiceMessageMetadata,
  sendDiscordVoiceMessage,
} from "./voice-message.js";

interface DiscordSendOpts {
  cfg?: OpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  filename?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
  components?: DiscordSendComponents;
  embeds?: DiscordSendEmbeds;
  silent?: boolean;
}

type DiscordClientRequest = ReturnType<typeof createDiscordClient>["request"];

const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;

interface DiscordChannelMessageResult {
  id?: string | null;
  channel_id?: string | null;
}

async function sendDiscordThreadTextChunks(params: {
  rest: RequestClient;
  threadId: string;
  chunks: readonly string[];
  request: DiscordClientRequest;
  maxLinesPerMessage?: number;
  chunkMode: ReturnType<typeof resolveChunkMode>;
  silent?: boolean;
}): Promise<void> {
  for (const chunk of params.chunks) {
    await sendDiscordText(
      params.rest,
      params.threadId,
      chunk,
      undefined,
      params.request,
      params.maxLinesPerMessage,
      undefined,
      undefined,
      params.chunkMode,
      params.silent,
    );
  }
}

/** Discord thread names are capped at 100 characters. */
const DISCORD_THREAD_NAME_LIMIT = 100;

/** Derive a thread title from the first non-empty line of the message text. */
function deriveForumThreadName(text: string): string {
  const firstLine =
    normalizeOptionalString(text.split("\n").find((line) => normalizeOptionalString(line))) ?? "";
  return firstLine.slice(0, DISCORD_THREAD_NAME_LIMIT) || new Date().toISOString().slice(0, 16);
}

/** Forum/Media channels cannot receive regular messages; detect them here. */
function isForumLikeType(channelType?: number): boolean {
  return channelType === ChannelType.GuildForum || channelType === ChannelType.GuildMedia;
}

function toDiscordSendResult(
  result: DiscordChannelMessageResult,
  fallbackChannelId: string,
): DiscordSendResult {
  return {
    channelId: String(result.channel_id ?? fallbackChannelId),
    messageId: result.id ? String(result.id) : "unknown",
  };
}

async function resolveDiscordSendTarget(
  to: string,
  opts: DiscordSendOpts,
): Promise<{ rest: RequestClient; request: DiscordClientRequest; channelId: string }> {
  const cfg = opts.cfg ?? loadConfig();
  const { rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId, cfg);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  return { channelId, request, rest };
}

export async function sendMessageDiscord(
  to: string,
  text: string,
  opts: DiscordSendOpts = {},
): Promise<DiscordSendResult> {
  const cfg = opts.cfg ?? loadConfig();
  const accountInfo = resolveDiscordAccount({
    accountId: opts.accountId,
    cfg,
  });
  const tableMode = resolveMarkdownTableMode({
    accountId: accountInfo.accountId,
    cfg,
    channel: "discord",
  });
  const chunkMode = resolveChunkMode(cfg, "discord", accountInfo.accountId);
  const mediaMaxBytes =
    typeof accountInfo.config.mediaMaxMb === "number"
      ? accountInfo.config.mediaMaxMb * 1024 * 1024
      : DEFAULT_DISCORD_MEDIA_MAX_MB * 1024 * 1024;
  const textWithTables = convertMarkdownTables(text ?? "", tableMode);
  const textWithMentions = rewriteDiscordKnownMentions(textWithTables, {
    accountId: accountInfo.accountId,
  });
  const { token, rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId, cfg);
  const { channelId } = await resolveChannelId(rest, recipient, request);

  // Forum/Media channels reject POST /messages; auto-create a thread post instead.
  const channelType = await resolveDiscordChannelType(rest, channelId);

  if (isForumLikeType(channelType)) {
    const threadName = deriveForumThreadName(textWithTables);
    const chunks = buildDiscordTextChunks(textWithMentions, {
      chunkMode,
      maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
    });
    const starterContent = chunks[0]?.trim() ? chunks[0] : threadName;
    const starterComponents = resolveDiscordSendComponents({
      components: opts.components,
      isFirst: true,
      text: starterContent,
    });
    const starterEmbeds = resolveDiscordSendEmbeds({ embeds: opts.embeds, isFirst: true });
    const silentFlags = opts.silent ? 1 << 12 : undefined;
    const starterPayload: MessagePayloadObject = buildDiscordMessagePayload({
      components: starterComponents,
      embeds: starterEmbeds,
      flags: silentFlags,
      text: starterContent,
    });
    let threadRes: { id: string; message?: { id: string; channel_id: string } };
    try {
      threadRes = (await request(
        () =>
          rest.post(Routes.threads(channelId), {
            body: {
              message: stripUndefinedFields(serializePayload(starterPayload)),
              name: threadName,
            },
          }) as Promise<{ id: string; message?: { id: string; channel_id: string } }>,
        "forum-thread",
      )) as { id: string; message?: { id: string; channel_id: string } };
    } catch (error) {
      throw await buildDiscordSendError(error, {
        channelId,
        hasMedia: Boolean(opts.mediaUrl),
        rest,
        token,
      });
    }

    const threadId = threadRes.id;
    const messageId = threadRes.message?.id ?? threadId;
    const resultChannelId = threadRes.message?.channel_id ?? threadId;
    const remainingChunks = chunks.slice(1);

    try {
      if (opts.mediaUrl) {
        const [mediaCaption, ...afterMediaChunks] = remainingChunks;
        await sendDiscordMedia(
          rest,
          threadId,
          mediaCaption ?? "",
          opts.mediaUrl,
          opts.filename,
          opts.mediaLocalRoots,
          opts.mediaReadFile,
          mediaMaxBytes,
          undefined,
          request,
          accountInfo.config.maxLinesPerMessage,
          undefined,
          undefined,
          chunkMode,
          opts.silent,
        );
        await sendDiscordThreadTextChunks({
          chunkMode,
          chunks: afterMediaChunks,
          maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
          request,
          rest,
          silent: opts.silent,
          threadId,
        });
      } else {
        await sendDiscordThreadTextChunks({
          chunkMode,
          chunks: remainingChunks,
          maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
          request,
          rest,
          silent: opts.silent,
          threadId,
        });
      }
    } catch (error) {
      throw await buildDiscordSendError(error, {
        channelId: threadId,
        hasMedia: Boolean(opts.mediaUrl),
        rest,
        token,
      });
    }

    recordChannelActivity({
      accountId: accountInfo.accountId,
      channel: "discord",
      direction: "outbound",
    });
    return toDiscordSendResult(
      {
        channel_id: resultChannelId,
        id: messageId,
      },
      channelId,
    );
  }

  let result: { id: string; channel_id: string } | { id: string | null; channel_id: string };
  try {
    if (opts.mediaUrl) {
      result = await sendDiscordMedia(
        rest,
        channelId,
        textWithMentions,
        opts.mediaUrl,
        opts.filename,
        opts.mediaLocalRoots,
        opts.mediaReadFile,
        mediaMaxBytes,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
        opts.components,
        opts.embeds,
        chunkMode,
        opts.silent,
      );
    } else {
      result = await sendDiscordText(
        rest,
        channelId,
        textWithMentions,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
        opts.components,
        opts.embeds,
        chunkMode,
        opts.silent,
      );
    }
  } catch (error) {
    throw await buildDiscordSendError(error, {
      channelId,
      hasMedia: Boolean(opts.mediaUrl),
      rest,
      token,
    });
  }

  recordChannelActivity({
    accountId: accountInfo.accountId,
    channel: "discord",
    direction: "outbound",
  });
  return toDiscordSendResult(result, channelId);
}

interface DiscordWebhookSendOpts {
  cfg?: OpenClawConfig;
  webhookId: string;
  webhookToken: string;
  accountId?: string;
  threadId?: string | number;
  replyTo?: string;
  username?: string;
  avatarUrl?: string;
  wait?: boolean;
}

function resolveWebhookExecutionUrl(params: {
  webhookId: string;
  webhookToken: string;
  threadId?: string | number;
  wait?: boolean;
}) {
  const baseUrl = new URL(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(params.webhookId)}/${encodeURIComponent(params.webhookToken)}`,
  );
  baseUrl.searchParams.set("wait", params.wait === false ? "false" : "true");
  if (params.threadId !== undefined && params.threadId !== null && params.threadId !== "") {
    baseUrl.searchParams.set("thread_id", String(params.threadId));
  }
  return baseUrl.toString();
}

export async function sendWebhookMessageDiscord(
  text: string,
  opts: DiscordWebhookSendOpts,
): Promise<DiscordSendResult> {
  const webhookId = normalizeOptionalString(opts.webhookId) ?? "";
  const webhookToken = normalizeOptionalString(opts.webhookToken) ?? "";
  if (!webhookId || !webhookToken) {
    throw new Error("Discord webhook id/token are required");
  }

  const replyTo = normalizeOptionalString(opts.replyTo) ?? "";
  const messageReference = replyTo ? { fail_if_not_exists: false, message_id: replyTo } : undefined;
  const { account, proxyFetch } = resolveDiscordClientAccountContext({
    accountId: opts.accountId,
    cfg: opts.cfg,
  });
  const rewrittenText = rewriteDiscordKnownMentions(text, {
    accountId: account.accountId,
  });

  const response = await (proxyFetch ?? fetch)(
    resolveWebhookExecutionUrl({
      threadId: opts.threadId,
      wait: opts.wait,
      webhookId,
      webhookToken,
    }),
    {
      body: JSON.stringify({
        avatar_url: normalizeOptionalString(opts.avatarUrl),
        content: rewrittenText,
        username: normalizeOptionalString(opts.username),
        ...(messageReference ? { message_reference: messageReference } : {}),
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(
      `Discord webhook send failed (${response.status}${raw ? `: ${raw.slice(0, 200)}` : ""})`,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    channel_id?: string;
  };
  try {
    recordChannelActivity({
      accountId: account.accountId,
      channel: "discord",
      direction: "outbound",
    });
  } catch {
    // Best-effort telemetry only.
  }
  return {
    channelId: payload.channel_id
      ? String(payload.channel_id)
      : opts.threadId
        ? String(opts.threadId)
        : "",
    messageId: payload.id ? String(payload.id) : "unknown",
  };
}

export async function sendStickerDiscord(
  to: string,
  stickerIds: string[],
  opts: DiscordSendOpts & { content?: string } = {},
): Promise<DiscordSendResult> {
  const { rest, request, channelId, rewrittenContent } = await resolveDiscordStructuredSendContext(
    to,
    opts,
  );
  const stickers = normalizeStickerIds(stickerIds);
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: rewrittenContent || undefined,
          sticker_ids: stickers,
        },
      }) as Promise<{ id: string; channel_id: string }>,
    "sticker",
  )) as { id: string; channel_id: string };
  return toDiscordSendResult(res, channelId);
}

export async function sendPollDiscord(
  to: string,
  poll: PollInput,
  opts: DiscordSendOpts & { content?: string } = {},
): Promise<DiscordSendResult> {
  const { rest, request, channelId, rewrittenContent } = await resolveDiscordStructuredSendContext(
    to,
    opts,
  );
  if (poll.durationSeconds !== undefined) {
    throw new Error("Discord polls do not support durationSeconds; use durationHours");
  }
  const payload = normalizeDiscordPollInput(poll);
  const flags = opts.silent ? SUPPRESS_NOTIFICATIONS_FLAG : undefined;
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: rewrittenContent || undefined,
          poll: payload,
          ...(flags ? { flags } : {}),
        },
      }) as Promise<{ id: string; channel_id: string }>,
    "poll",
  )) as { id: string; channel_id: string };
  return toDiscordSendResult(res, channelId);
}

async function resolveDiscordStructuredSendContext(
  to: string,
  opts: DiscordSendOpts & { content?: string },
): Promise<{
  rest: RequestClient;
  request: DiscordClientRequest;
  channelId: string;
  rewrittenContent?: string;
}> {
  const cfg = opts.cfg ?? loadConfig();
  const accountInfo = resolveDiscordAccount({
    accountId: opts.accountId,
    cfg,
  });
  const { rest, request, channelId } = await resolveDiscordSendTarget(to, opts);
  const content = opts.content?.trim();
  const rewrittenContent = content
    ? rewriteDiscordKnownMentions(content, {
        accountId: accountInfo.accountId,
      })
    : undefined;
  return { channelId, request, rest, rewrittenContent };
}

interface VoiceMessageOpts {
  cfg?: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
  silent?: boolean;
}

async function materializeVoiceMessageInput(mediaUrl: string): Promise<{ filePath: string }> {
  // Security: reuse the standard media loader so we apply SSRF guards + allowed-local-root checks.
  // Then write to a private temp file so ffmpeg/ffprobe never sees the original URL/path string.
  const media = await loadWebMediaRaw(mediaUrl, maxBytesForKind("audio"));
  const extFromName = media.fileName ? path.extname(media.fileName) : "";
  const extFromMime = media.contentType ? extensionForMime(media.contentType) : "";
  const ext = extFromName || extFromMime || ".bin";
  const tempDir = resolvePreferredOpenClawTmpDir();
  const filePath = path.join(tempDir, `voice-src-${crypto.randomUUID()}${ext}`);
  await fs.writeFile(filePath, media.buffer, { mode: 0o600 });
  return { filePath };
}

/**
 * Send a voice message to Discord.
 *
 * Voice messages are a special Discord feature that displays audio with a waveform
 * visualization. They require OGG/Opus format and cannot include text content.
 *
 * @param to - Recipient (user ID for DM or channel ID)
 * @param audioPath - Path to local audio file (will be converted to OGG/Opus if needed)
 * @param opts - Send options
 */
export async function sendVoiceMessageDiscord(
  to: string,
  audioPath: string,
  opts: VoiceMessageOpts = {},
): Promise<DiscordSendResult> {
  const { filePath: localInputPath } = await materializeVoiceMessageInput(audioPath);
  let oggPath: string | null = null;
  let oggCleanup = false;
  let token: string | undefined;
  let rest: RequestClient | undefined;
  let channelId: string | undefined;

  try {
    const cfg = opts.cfg ?? loadConfig();
    const accountInfo = resolveDiscordAccount({
      accountId: opts.accountId,
      cfg,
    });
    const client = createDiscordClient(opts, cfg);
    ({ token } = client);
    ({ rest } = client);
    const { request } = client;
    const recipient = await parseAndResolveRecipient(to, opts.accountId, cfg);
    ({ channelId } = await resolveChannelId(rest, recipient, request));

    // Convert to OGG/Opus if needed
    const ogg = await ensureOggOpus(localInputPath);
    oggPath = ogg.path;
    oggCleanup = ogg.cleanup;

    // Get voice message metadata (duration and waveform)
    const metadata = await getVoiceMessageMetadata(oggPath);

    // Read the audio file
    const audioBuffer = await fs.readFile(oggPath);

    // Send the voice message
    const result = await sendDiscordVoiceMessage(
      rest,
      channelId,
      audioBuffer,
      metadata,
      opts.replyTo,
      request,
      opts.silent,
      token,
    );

    recordChannelActivity({
      accountId: accountInfo.accountId,
      channel: "discord",
      direction: "outbound",
    });

    return toDiscordSendResult(result, channelId);
  } catch (error) {
    if (channelId && rest && token) {
      throw await buildDiscordSendError(error, {
        channelId,
        hasMedia: true,
        rest,
        token,
      });
    }
    throw error;
  } finally {
    await unlinkIfExists(oggCleanup ? oggPath : null);
    await unlinkIfExists(localInputPath);
  }
}
