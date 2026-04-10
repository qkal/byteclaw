import {
  type MessagePayloadFile,
  type MessagePayloadObject,
  type RequestClient,
  serializePayload,
} from "@buape/carbon";
import { ChannelType, Routes } from "discord-api-types/v10";
import { type OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { registerDiscordComponentEntries } from "./components-registry.js";
import {
  type DiscordComponentBuildResult,
  type DiscordComponentMessageSpec,
  buildDiscordComponentMessage,
  buildDiscordComponentMessageFlags,
  resolveDiscordComponentAttachmentName,
} from "./components.js";
import { parseAndResolveRecipient } from "./recipient-resolution.js";
import { loadOutboundMediaFromUrl } from "./runtime-api.js";
import { sendMessageDiscord } from "./send.outbound.js";
import {
  SUPPRESS_NOTIFICATIONS_FLAG,
  buildDiscordSendError,
  createDiscordClient,
  resolveChannelId,
  resolveDiscordChannelType,
  stripUndefinedFields,
  toDiscordFileBlob,
} from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";

const DISCORD_FORUM_LIKE_TYPES = new Set<number>([ChannelType.GuildForum, ChannelType.GuildMedia]);

function extractComponentAttachmentNames(spec: DiscordComponentMessageSpec): string[] {
  const names: string[] = [];
  for (const block of spec.blocks ?? []) {
    if (block.type === "file") {
      names.push(resolveDiscordComponentAttachmentName(block.file));
    }
  }
  return names;
}

function hasComponentAttachmentBlock(spec: DiscordComponentMessageSpec): boolean {
  return (spec.blocks ?? []).some((block) => block.type === "file");
}

function withImplicitComponentAttachmentBlock(
  spec: DiscordComponentMessageSpec,
  attachmentName: string | undefined,
): DiscordComponentMessageSpec {
  if (!attachmentName || hasComponentAttachmentBlock(spec)) {
    return spec;
  }
  // Discord File components must point at the uploaded attachment name. Add the
  // Matching file block automatically so callers do not have to duplicate it.
  return {
    ...spec,
    blocks: [
      ...(spec.blocks ?? []),
      {
        file: `attachment://${attachmentName}`,
        type: "file",
      },
    ],
  };
}

function hasClassicOnlyBlocks(spec: DiscordComponentMessageSpec): boolean {
  return (spec.blocks ?? []).every((block) => block.type === "text" || block.type === "file");
}

function hasUnsupportedClassicFeatures(spec: DiscordComponentMessageSpec): boolean {
  return Boolean(spec.modal || spec.container);
}

function hasAtMostOneNonSpoilerFile(spec: DiscordComponentMessageSpec): boolean {
  let fileBlockCount = 0;
  for (const block of spec.blocks ?? []) {
    if (block.type !== "file") {
      continue;
    }
    fileBlockCount += 1;
    if (block.spoiler) {
      return false;
    }
  }
  return fileBlockCount <= 1;
}

type ClassicDiscordMessageDecision =
  | {
      mode: "classic";
      reason: "plain-text-single-file";
    }
  | {
      mode: "components";
      reason: "unsupported-feature" | "unsupported-block" | "multiple-or-spoiler-files";
    };

/**
 * Keep the downgrade rules explicit because this path is only safe when the
 * spec means exactly what a plain Discord message can represent.
 */
function getClassicDiscordMessageDecision(
  spec: DiscordComponentMessageSpec,
): ClassicDiscordMessageDecision {
  if (hasUnsupportedClassicFeatures(spec)) {
    return { mode: "components", reason: "unsupported-feature" };
  }
  if (!hasClassicOnlyBlocks(spec)) {
    return { mode: "components", reason: "unsupported-block" };
  }
  if (!hasAtMostOneNonSpoilerFile(spec)) {
    return { mode: "components", reason: "multiple-or-spoiler-files" };
  }
  return { mode: "classic", reason: "plain-text-single-file" };
}

function collapseClassicComponentText(spec: DiscordComponentMessageSpec): string {
  const parts: string[] = [];
  const addPart = (value: string | undefined) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || parts.includes(trimmed)) {
      return;
    }
    parts.push(trimmed);
  };

  addPart(spec.text);
  for (const block of spec.blocks ?? []) {
    if (block.type === "text") {
      addPart(block.text);
    }
  }
  return parts.join("\n\n");
}

interface DiscordComponentSendOpts {
  cfg?: OpenClawConfig;
  accountId?: string;
  token?: string;
  rest?: RequestClient;
  silent?: boolean;
  replyTo?: string;
  sessionKey?: string;
  agentId?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  filename?: string;
}

export function registerBuiltDiscordComponentMessage(params: {
  buildResult: DiscordComponentBuildResult;
  messageId: string;
}): void {
  registerDiscordComponentEntries({
    entries: params.buildResult.entries,
    messageId: params.messageId,
    modals: params.buildResult.modals,
  });
}

async function buildDiscordComponentPayload(params: {
  spec: DiscordComponentMessageSpec;
  opts: DiscordComponentSendOpts;
  accountId: string;
}): Promise<{
  body: ReturnType<typeof stripUndefinedFields>;
  buildResult: ReturnType<typeof buildDiscordComponentMessage>;
}> {
  const messageReference = params.opts.replyTo
    ? { fail_if_not_exists: false, message_id: params.opts.replyTo }
    : undefined;

  let { spec } = params;
  let resolvedFileName: string | undefined;
  let files: MessagePayloadFile[] | undefined;
  if (params.opts.mediaUrl) {
    const media = await loadOutboundMediaFromUrl(params.opts.mediaUrl, {
      mediaAccess: params.opts.mediaAccess,
      mediaLocalRoots: params.opts.mediaLocalRoots,
      mediaReadFile: params.opts.mediaReadFile,
    });
    const filenameOverride = params.opts.filename?.trim();
    resolvedFileName = filenameOverride || media.fileName || "upload";
    spec = withImplicitComponentAttachmentBlock(spec, resolvedFileName);
    const fileData = toDiscordFileBlob(media.buffer);
    files = [{ data: fileData, name: resolvedFileName }];
  }

  const attachmentNames = extractComponentAttachmentNames(spec);
  const uniqueAttachmentNames = [...new Set(attachmentNames)];
  if (uniqueAttachmentNames.length > 1) {
    throw new Error(
      "Discord component attachments currently support a single file. Use media-gallery for multiple files.",
    );
  }
  const expectedAttachmentName = uniqueAttachmentNames[0];
  if (expectedAttachmentName && resolvedFileName && expectedAttachmentName !== resolvedFileName) {
    throw new Error(
      `Component file block expects attachment "${expectedAttachmentName}", but the uploaded file is "${resolvedFileName}". Update components.blocks[].file or provide a matching filename.`,
    );
  }
  if (!params.opts.mediaUrl && expectedAttachmentName) {
    throw new Error(
      "Discord component file blocks require a media attachment (media/path/filePath).",
    );
  }

  const buildResult = buildDiscordComponentMessage({
    accountId: params.accountId,
    agentId: params.opts.agentId,
    sessionKey: params.opts.sessionKey,
    spec,
  });
  const flags = buildDiscordComponentMessageFlags(buildResult.components);
  const finalFlags = params.opts.silent
    ? (flags ?? 0) | SUPPRESS_NOTIFICATIONS_FLAG
    : (flags ?? undefined);

  const payload: MessagePayloadObject = {
    components: buildResult.components,
    ...(finalFlags ? { flags: finalFlags } : {}),
    ...(files ? { files } : {}),
  };
  const body = stripUndefinedFields({
    ...serializePayload(payload),
    ...(messageReference ? { message_reference: messageReference } : {}),
  });

  return { body, buildResult };
}

export async function sendDiscordComponentMessage(
  to: string,
  spec: DiscordComponentMessageSpec,
  opts: DiscordComponentSendOpts = {},
): Promise<DiscordSendResult> {
  const classicDecision = getClassicDiscordMessageDecision(spec);
  if (opts.mediaUrl && classicDecision.mode === "classic") {
    return await sendMessageDiscord(to, collapseClassicComponentText(spec), {
      accountId: opts.accountId,
      cfg: opts.cfg,
      filename: opts.filename,
      mediaAccess: opts.mediaAccess,
      mediaLocalRoots: opts.mediaLocalRoots,
      mediaReadFile: opts.mediaReadFile,
      mediaUrl: opts.mediaUrl,
      replyTo: opts.replyTo,
      rest: opts.rest,
      silent: opts.silent,
      token: opts.token,
    });
  }

  const cfg = opts.cfg ?? loadConfig();
  const accountInfo = resolveDiscordAccount({ accountId: opts.accountId, cfg });
  const { token, rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId, cfg);
  const { channelId } = await resolveChannelId(rest, recipient, request);

  const channelType = await resolveDiscordChannelType(rest, channelId);

  if (channelType && DISCORD_FORUM_LIKE_TYPES.has(channelType)) {
    throw new Error("Discord components are not supported in forum-style channels");
  }

  const { body, buildResult } = await buildDiscordComponentPayload({
    accountId: accountInfo.accountId,
    opts,
    spec,
  });

  let result: { id: string; channel_id: string };
  try {
    result = (await request(
      () =>
        rest.post(Routes.channelMessages(channelId), {
          body,
        }) as Promise<{ id: string; channel_id: string }>,
      "components",
    )) as { id: string; channel_id: string };
  } catch (error) {
    throw await buildDiscordSendError(error, {
      channelId,
      hasMedia: Boolean(opts.mediaUrl),
      rest,
      token,
    });
  }

  registerBuiltDiscordComponentMessage({
    buildResult,
    messageId: result.id,
  });

  recordChannelActivity({
    accountId: accountInfo.accountId,
    channel: "discord",
    direction: "outbound",
  });

  return {
    channelId: result.channel_id ?? channelId,
    messageId: result.id ?? "unknown",
  };
}

export async function editDiscordComponentMessage(
  to: string,
  messageId: string,
  spec: DiscordComponentMessageSpec,
  opts: DiscordComponentSendOpts = {},
): Promise<DiscordSendResult> {
  const cfg = opts.cfg ?? loadConfig();
  const accountInfo = resolveDiscordAccount({ accountId: opts.accountId, cfg });
  const { token, rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId, cfg);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  const { body, buildResult } = await buildDiscordComponentPayload({
    accountId: accountInfo.accountId,
    opts,
    spec,
  });

  let result: { id: string; channel_id: string };
  try {
    result = (await request(
      () =>
        rest.patch(Routes.channelMessage(channelId, messageId), {
          body,
        }) as Promise<{ id: string; channel_id: string }>,
      "components",
    )) as { id: string; channel_id: string };
  } catch (error) {
    throw await buildDiscordSendError(error, {
      channelId,
      hasMedia: Boolean(opts.mediaUrl),
      rest,
      token,
    });
  }

  registerBuiltDiscordComponentMessage({
    buildResult,
    messageId: result.id ?? messageId,
  });

  recordChannelActivity({
    accountId: accountInfo.accountId,
    channel: "discord",
    direction: "outbound",
  });

  return {
    channelId: result.channel_id ?? channelId,
    messageId: result.id ?? messageId,
  };
}
