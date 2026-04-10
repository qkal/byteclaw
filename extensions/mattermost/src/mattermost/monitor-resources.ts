import {
  type MattermostChannel,
  type MattermostClient,
  type MattermostUser,
  fetchMattermostChannel,
  fetchMattermostUser,
  sendMattermostTyping,
  updateMattermostPost,
} from "./client.js";
import { type MattermostInteractionResponse, buildButtonProps } from "./interactions.js";

export type MattermostMediaKind = "image" | "audio" | "video" | "document" | "unknown";

export interface MattermostMediaInfo {
  path: string;
  contentType?: string;
  kind: MattermostMediaKind;
}

const CHANNEL_CACHE_TTL_MS = 5 * 60_000;
const USER_CACHE_TTL_MS = 10 * 60_000;

type FetchRemoteMedia = (params: {
  url: string;
  requestInit?: RequestInit;
  filePathHint?: string;
  maxBytes: number;
  ssrfPolicy?: { allowedHostnames?: string[] };
}) => Promise<{ buffer: Uint8Array; contentType?: string | null }>;

type SaveMediaBuffer = (
  buffer: Uint8Array,
  contentType: string | undefined,
  direction: "inbound" | "outbound",
  maxBytes: number,
) => Promise<{ path: string; contentType?: string | null }>;

export function createMattermostMonitorResources(params: {
  accountId: string;
  callbackUrl: string;
  client: MattermostClient;
  logger: { debug?: (...args: unknown[]) => void };
  mediaMaxBytes: number;
  fetchRemoteMedia: FetchRemoteMedia;
  saveMediaBuffer: SaveMediaBuffer;
  mediaKindFromMime: (contentType?: string) => MattermostMediaKind | null | undefined;
}) {
  const {
    accountId,
    callbackUrl,
    client,
    logger,
    mediaMaxBytes,
    fetchRemoteMedia,
    saveMediaBuffer,
    mediaKindFromMime,
  } = params;
  const channelCache = new Map<string, { value: MattermostChannel | null; expiresAt: number }>();
  const userCache = new Map<string, { value: MattermostUser | null; expiresAt: number }>();

  const resolveMattermostMedia = async (
    fileIds?: string[] | null,
  ): Promise<MattermostMediaInfo[]> => {
    const ids = (fileIds ?? []).map((id) => id?.trim()).filter(Boolean);
    if (ids.length === 0) {
      return [];
    }
    const out: MattermostMediaInfo[] = [];
    for (const fileId of ids) {
      try {
        const fetched = await fetchRemoteMedia({
          filePathHint: fileId,
          maxBytes: mediaMaxBytes,
          requestInit: {
            headers: {
              Authorization: `Bearer ${client.token}`,
            },
          },
          ssrfPolicy: { allowedHostnames: [new URL(client.baseUrl).hostname] },
          url: `${client.apiBaseUrl}/files/${fileId}`,
        });
        const saved = await saveMediaBuffer(
          Buffer.from(fetched.buffer),
          fetched.contentType ?? undefined,
          "inbound",
          mediaMaxBytes,
        );
        const contentType = saved.contentType ?? fetched.contentType ?? undefined;
        out.push({
          contentType,
          kind: mediaKindFromMime(contentType) ?? "unknown",
          path: saved.path,
        });
      } catch (error) {
        logger.debug?.(`mattermost: failed to download file ${fileId}: ${String(error)}`);
      }
    }
    return out;
  };

  const sendTypingIndicator = async (channelId: string, parentId?: string) => {
    await sendMattermostTyping(client, { channelId, parentId });
  };

  const resolveChannelInfo = async (channelId: string): Promise<MattermostChannel | null> => {
    const cached = channelCache.get(channelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const info = await fetchMattermostChannel(client, channelId);
      channelCache.set(channelId, {
        expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS,
        value: info,
      });
      return info;
    } catch (error) {
      logger.debug?.(`mattermost: channel lookup failed: ${String(error)}`);
      channelCache.set(channelId, {
        expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS,
        value: null,
      });
      return null;
    }
  };

  const resolveUserInfo = async (userId: string): Promise<MattermostUser | null> => {
    const cached = userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const info = await fetchMattermostUser(client, userId);
      userCache.set(userId, {
        expiresAt: Date.now() + USER_CACHE_TTL_MS,
        value: info,
      });
      return info;
    } catch (error) {
      logger.debug?.(`mattermost: user lookup failed: ${String(error)}`);
      userCache.set(userId, {
        expiresAt: Date.now() + USER_CACHE_TTL_MS,
        value: null,
      });
      return null;
    }
  };

  const buildModelPickerProps = (
    channelId: string,
    buttons: unknown[],
  ): Record<string, unknown> | undefined =>
    buildButtonProps({
      accountId,
      buttons,
      callbackUrl,
      channelId,
    });

  const updateModelPickerPost = async (params: {
    channelId: string;
    postId: string;
    message: string;
    buttons?: unknown[];
  }): Promise<MattermostInteractionResponse> => {
    const props = buildModelPickerProps(params.channelId, params.buttons ?? []) ?? {
      attachments: [],
    };
    await updateMattermostPost(client, params.postId, {
      message: params.message,
      props,
    });
    return {};
  };

  return {
    resolveChannelInfo,
    resolveMattermostMedia,
    resolveUserInfo,
    sendTypingIndicator,
    updateModelPickerPost,
  };
}
