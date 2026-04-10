import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  convertMarkdownTables,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  type CreateDmChannelRetryOptions,
  type MattermostUser,
  createMattermostClient,
  createMattermostDirectChannelWithRetry,
  createMattermostPost,
  fetchMattermostChannelByName,
  fetchMattermostMe,
  fetchMattermostUserByUsername,
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  uploadMattermostFile,
} from "./client.js";
import {
  type MattermostInteractiveButtonInput,
  buildButtonProps,
  resolveInteractionCallbackUrl,
  setInteractionSecret,
} from "./interactions.js";
import { type OpenClawConfig, loadOutboundMediaFromUrl } from "./runtime-api.js";
import { isMattermostId, resolveMattermostOpaqueTarget } from "./target-resolution.js";

export interface MattermostSendOpts {
  cfg?: OpenClawConfig;
  botToken?: string;
  baseUrl?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  replyToId?: string;
  props?: Record<string, unknown>;
  buttons?: unknown[];
  attachmentText?: string;
  /** Retry options for DM channel creation */
  dmRetryOptions?: CreateDmChannelRetryOptions;
}

export interface MattermostSendResult {
  messageId: string;
  channelId: string;
}

export type MattermostReplyButtons = (
  | MattermostInteractiveButtonInput
  | MattermostInteractiveButtonInput[]
)[];

type MattermostTarget =
  | { kind: "channel"; id: string }
  | { kind: "channel-name"; name: string }
  | { kind: "user"; id?: string; username?: string };

const botUserCache = new Map<string, MattermostUser>();
const userByNameCache = new Map<string, MattermostUser>();
const channelByNameCache = new Map<string, string>();
const dmChannelCache = new Map<string, string>();

const getCore = () => getMattermostRuntime();

function recordMattermostOutboundActivity(accountId: string): void {
  try {
    getCore().channel.activity.record({
      accountId,
      channel: "mattermost",
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Mattermost runtime not initialized") {
      throw error;
    }
  }
}

function cacheKey(baseUrl: string, token: string): string {
  return `${baseUrl}::${token}`;
}

function normalizeMessage(text: string, mediaUrl?: string): string {
  const trimmed = normalizeOptionalString(text) ?? "";
  const media = normalizeOptionalString(mediaUrl);
  return [trimmed, media].filter(Boolean).join("\n");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
export function parseMattermostTarget(raw: string): MattermostTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Mattermost sends");
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    if (!id) {
      throw new Error("Channel id is required for Mattermost sends");
    }
    if (id.startsWith("#")) {
      const name = id.slice(1).trim();
      if (!name) {
        throw new Error("Channel name is required for Mattermost sends");
      }
      return { kind: "channel-name", name };
    }
    if (!isMattermostId(id)) {
      return { kind: "channel-name", name: id };
    }
    return { id, kind: "channel" };
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    if (!id) {
      throw new Error("User id is required for Mattermost sends");
    }
    return { id, kind: "user" };
  }
  if (lower.startsWith("mattermost:")) {
    const id = trimmed.slice("mattermost:".length).trim();
    if (!id) {
      throw new Error("User id is required for Mattermost sends");
    }
    return { id, kind: "user" };
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    if (!username) {
      throw new Error("Username is required for Mattermost sends");
    }
    return { kind: "user", username };
  }
  if (trimmed.startsWith("#")) {
    const name = trimmed.slice(1).trim();
    if (!name) {
      throw new Error("Channel name is required for Mattermost sends");
    }
    return { kind: "channel-name", name };
  }
  if (!isMattermostId(trimmed)) {
    return { kind: "channel-name", name: trimmed };
  }
  return { id: trimmed, kind: "channel" };
}

async function resolveBotUser(
  baseUrl: string,
  token: string,
  allowPrivateNetwork?: boolean,
): Promise<MattermostUser> {
  const key = cacheKey(baseUrl, token);
  const cached = botUserCache.get(key);
  if (cached) {
    return cached;
  }
  const client = createMattermostClient({ allowPrivateNetwork, baseUrl, botToken: token });
  const user = await fetchMattermostMe(client);
  botUserCache.set(key, user);
  return user;
}

async function resolveUserIdByUsername(params: {
  baseUrl: string;
  token: string;
  username: string;
  allowPrivateNetwork?: boolean;
}): Promise<string> {
  const { baseUrl, token, username } = params;
  const key = `${cacheKey(baseUrl, token)}::${normalizeLowercaseStringOrEmpty(username)}`;
  const cached = userByNameCache.get(key);
  if (cached?.id) {
    return cached.id;
  }
  const client = createMattermostClient({
    allowPrivateNetwork: params.allowPrivateNetwork,
    baseUrl,
    botToken: token,
  });
  const user = await fetchMattermostUserByUsername(client, username);
  userByNameCache.set(key, user);
  return user.id;
}

async function resolveChannelIdByName(params: {
  baseUrl: string;
  token: string;
  name: string;
  allowPrivateNetwork?: boolean;
}): Promise<string> {
  const { baseUrl, token, name } = params;
  const key = `${cacheKey(baseUrl, token)}::channel::${normalizeLowercaseStringOrEmpty(name)}`;
  const cached = channelByNameCache.get(key);
  if (cached) {
    return cached;
  }
  const client = createMattermostClient({
    allowPrivateNetwork: params.allowPrivateNetwork,
    baseUrl,
    botToken: token,
  });
  const me = await fetchMattermostMe(client);
  const teams = await fetchMattermostUserTeams(client, me.id);
  for (const team of teams) {
    try {
      const channel = await fetchMattermostChannelByName(client, team.id, name);
      if (channel?.id) {
        channelByNameCache.set(key, channel.id);
        return channel.id;
      }
    } catch {
      // Channel not found in this team, try next
    }
  }
  throw new Error(`Mattermost channel "#${name}" not found in any team the bot belongs to`);
}

interface ResolveTargetChannelIdParams {
  target: MattermostTarget;
  baseUrl: string;
  token: string;
  allowPrivateNetwork?: boolean;
  dmRetryOptions?: CreateDmChannelRetryOptions;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}

function mergeDmRetryOptions(
  base?: CreateDmChannelRetryOptions,
  override?: CreateDmChannelRetryOptions,
): CreateDmChannelRetryOptions | undefined {
  const merged: CreateDmChannelRetryOptions = {
    initialDelayMs: override?.initialDelayMs ?? base?.initialDelayMs,
    maxDelayMs: override?.maxDelayMs ?? base?.maxDelayMs,
    maxRetries: override?.maxRetries ?? base?.maxRetries,
    onRetry: override?.onRetry,
    timeoutMs: override?.timeoutMs ?? base?.timeoutMs,
  };

  if (
    merged.maxRetries === undefined &&
    merged.initialDelayMs === undefined &&
    merged.maxDelayMs === undefined &&
    merged.timeoutMs === undefined &&
    merged.onRetry === undefined
  ) {
    return undefined;
  }

  return merged;
}

async function resolveTargetChannelId(params: ResolveTargetChannelIdParams): Promise<string> {
  if (params.target.kind === "channel") {
    return params.target.id;
  }
  if (params.target.kind === "channel-name") {
    return await resolveChannelIdByName({
      allowPrivateNetwork: params.allowPrivateNetwork,
      baseUrl: params.baseUrl,
      name: params.target.name,
      token: params.token,
    });
  }
  const userId = params.target.id
    ? params.target.id
    : await resolveUserIdByUsername({
        allowPrivateNetwork: params.allowPrivateNetwork,
        baseUrl: params.baseUrl,
        token: params.token,
        username: params.target.username ?? "",
      });
  const dmKey = `${cacheKey(params.baseUrl, params.token)}::dm::${userId}`;
  const cachedDm = dmChannelCache.get(dmKey);
  if (cachedDm) {
    return cachedDm;
  }
  const botUser = await resolveBotUser(params.baseUrl, params.token, params.allowPrivateNetwork);
  const client = createMattermostClient({
    allowPrivateNetwork: params.allowPrivateNetwork,
    baseUrl: params.baseUrl,
    botToken: params.token,
  });

  const channel = await createMattermostDirectChannelWithRetry(client, [botUser.id, userId], {
    ...params.dmRetryOptions,
    onRetry: (attempt, delayMs, error) => {
      // Call user's onRetry if provided
      params.dmRetryOptions?.onRetry?.(attempt, delayMs, error);
      // Log if verbose mode is enabled
      if (params.logger) {
        params.logger.warn?.(
          `DM channel creation retry ${attempt} after ${delayMs}ms: ${error.message}`,
        );
      }
    },
  });
  dmChannelCache.set(dmKey, channel.id);
  return channel.id;
}

interface MattermostSendContext {
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  baseUrl: string;
  channelId: string;
  allowPrivateNetwork?: boolean;
}

async function resolveMattermostSendContext(
  to: string,
  opts: MattermostSendOpts = {},
): Promise<MattermostSendContext> {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "mattermost" });
  const cfg = opts.cfg ?? core.config.loadConfig();
  const account = resolveMattermostAccount({
    accountId: opts.accountId,
    cfg,
  });
  const token = normalizeOptionalString(opts.botToken) ?? normalizeOptionalString(account.botToken);
  if (!token) {
    throw new Error(
      `Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`,
    );
  }
  const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`,
    );
  }

  const trimmedTo = normalizeOptionalString(to) ?? "";
  const opaqueTarget = await resolveMattermostOpaqueTarget({
    baseUrl,
    input: trimmedTo,
    token,
  });
  const target =
    opaqueTarget?.kind === "user"
      ? { id: opaqueTarget.id, kind: "user" as const }
      : opaqueTarget?.kind === "channel"
        ? { id: opaqueTarget.id, kind: "channel" as const }
        : parseMattermostTarget(trimmedTo);
  // Build retry options from account config, allowing opts to override
  const accountRetryConfig: CreateDmChannelRetryOptions | undefined = account.config.dmChannelRetry
    ? {
        initialDelayMs: account.config.dmChannelRetry.initialDelayMs,
        maxDelayMs: account.config.dmChannelRetry.maxDelayMs,
        maxRetries: account.config.dmChannelRetry.maxRetries,
        timeoutMs: account.config.dmChannelRetry.timeoutMs,
      }
    : undefined;
  const dmRetryOptions = mergeDmRetryOptions(accountRetryConfig, opts.dmRetryOptions);

  const allowPrivateNetwork = isPrivateNetworkOptInEnabled(account.config);
  const channelId = await resolveTargetChannelId({
    allowPrivateNetwork,
    baseUrl,
    dmRetryOptions,
    logger: core.logging.shouldLogVerbose() ? logger : undefined,
    target,
    token,
  });

  return {
    accountId: account.accountId,
    allowPrivateNetwork,
    baseUrl,
    cfg,
    channelId,
    token,
  };
}

export async function resolveMattermostSendChannelId(
  to: string,
  opts: MattermostSendOpts = {},
): Promise<string> {
  return (await resolveMattermostSendContext(to, opts)).channelId;
}

export async function sendMessageMattermost(
  to: string,
  text: string,
  opts: MattermostSendOpts = {},
): Promise<MattermostSendResult> {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "mattermost" });
  const { cfg, accountId, token, baseUrl, channelId, allowPrivateNetwork } =
    await resolveMattermostSendContext(to, opts);

  const client = createMattermostClient({ allowPrivateNetwork, baseUrl, botToken: token });
  let { props } = opts;
  if (!props && Array.isArray(opts.buttons) && opts.buttons.length > 0) {
    setInteractionSecret(accountId, token);
    props = buildButtonProps({
      accountId,
      buttons: opts.buttons,
      callbackUrl: resolveInteractionCallbackUrl(accountId, {
        gateway: cfg.gateway,
        interactions: resolveMattermostAccount({
          accountId,
          cfg,
        }).config?.interactions,
      }),
      channelId,
      text: opts.attachmentText,
    });
  }
  let message = normalizeOptionalString(text) ?? "";
  let fileIds: string[] | undefined;
  let uploadError: Error | undefined;
  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    try {
      const media = await loadOutboundMediaFromUrl(mediaUrl, {
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
      });
      const fileInfo = await uploadMattermostFile(client, {
        buffer: media.buffer,
        channelId,
        contentType: media.contentType ?? undefined,
        fileName: media.fileName ?? "upload",
      });
      fileIds = [fileInfo.id];
    } catch (error) {
      uploadError = error instanceof Error ? error : new Error(String(error));
      if (core.logging.shouldLogVerbose()) {
        logger.debug?.(
          `mattermost send: media upload failed, falling back to URL text: ${String(error)}`,
        );
      }
      message = normalizeMessage(message, isHttpUrl(mediaUrl) ? mediaUrl : "");
    }
  }

  if (message) {
    const tableMode = resolveMarkdownTableMode({
      accountId,
      cfg,
      channel: "mattermost",
    });
    message = convertMarkdownTables(message, tableMode);
  }

  if (!message && (!fileIds || fileIds.length === 0)) {
    if (uploadError) {
      throw new Error(`Mattermost media upload failed: ${uploadError.message}`);
    }
    throw new Error("Mattermost message is empty");
  }

  const post = await createMattermostPost(client, {
    channelId,
    fileIds,
    message,
    props,
    rootId: opts.replyToId,
  });

  recordMattermostOutboundActivity(accountId);

  return {
    channelId,
    messageId: post.id ?? "unknown",
  };
}
