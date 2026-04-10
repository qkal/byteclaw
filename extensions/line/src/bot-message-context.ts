import type { webhook } from "@line/bot-sdk";
import {
  formatInboundEnvelope,
  formatLocationText,
  resolveInboundSessionEnvelopeContext,
  toLocationContext,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  ensureConfiguredBindingRouteReady,
  getSessionBindingService,
  recordInboundSession,
  resolveConfiguredBindingRoute,
  resolvePinnedMainDmOwnerFromAllowlist,
} from "openclaw/plugin-sdk/conversation-runtime";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import {
  deriveLastRoutePolicy,
  resolveAgentIdFromSessionKey,
  resolveAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { normalizeAllowFrom } from "./bot-access.js";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import type { ResolvedLineAccount } from "./types.js";

type EventSource = webhook.Source | undefined;
type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;
type StickerEventMessage = webhook.StickerMessageContent;

interface MediaRef {
  path: string;
  contentType?: string;
}

interface BuildLineMessageContextParams {
  event: MessageEvent;
  allMedia: MediaRef[];
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  commandAuthorized: boolean;
  groupHistories?: Map<string, HistoryEntry[]>;
  historyLimit?: number;
}

export interface LineSourceInfo {
  userId?: string;
  groupId?: string;
  roomId?: string;
  isGroup: boolean;
}

export function getLineSourceInfo(source: EventSource): LineSourceInfo {
  if (!source) {
    return { groupId: undefined, isGroup: false, roomId: undefined, userId: undefined };
  }
  const userId =
    source.type === "user"
      ? source.userId
      : source.type === "group"
        ? source.userId
        : source.type === "room"
          ? source.userId
          : undefined;
  const groupId = source.type === "group" ? source.groupId : undefined;
  const roomId = source.type === "room" ? source.roomId : undefined;
  const isGroup = source.type === "group" || source.type === "room";

  return { groupId, isGroup, roomId, userId };
}

function buildPeerId(source: EventSource): string {
  if (!source) {
    return "unknown";
  }
  const groupKey =
    normalizeOptionalString(source.type === "group" ? source.groupId : undefined) ??
    normalizeOptionalString(source.type === "room" ? source.roomId : undefined);
  if (groupKey) {
    return groupKey;
  }
  if (source.type === "user" && source.userId) {
    return source.userId;
  }
  return "unknown";
}

async function resolveLineInboundRoute(params: {
  source: EventSource;
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
}): Promise<{
  userId?: string;
  groupId?: string;
  roomId?: string;
  isGroup: boolean;
  peerId: string;
  route: ReturnType<typeof resolveAgentRoute>;
}> {
  recordChannelActivity({
    accountId: params.account.accountId,
    channel: "line",
    direction: "inbound",
  });

  const { userId, groupId, roomId, isGroup } = getLineSourceInfo(params.source);
  const peerId = buildPeerId(params.source);
  let route = resolveAgentRoute({
    accountId: params.account.accountId,
    cfg: params.cfg,
    channel: "line",
    peer: {
      id: peerId,
      kind: isGroup ? "group" : "direct",
    },
  });

  const configuredRoute = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    conversation: {
      accountId: params.account.accountId,
      channel: "line",
      conversationId: peerId,
    },
    route,
  });
  let configuredBinding = configuredRoute.bindingResolution;
  const configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
  ({ route } = configuredRoute);

  const boundConversation = getSessionBindingService().resolveByConversation({
    accountId: params.account.accountId,
    channel: "line",
    conversationId: peerId,
  });
  const boundSessionKey = boundConversation?.targetSessionKey?.trim();
  if (boundConversation && boundSessionKey) {
    route = {
      ...route,
      agentId: resolveAgentIdFromSessionKey(boundSessionKey) || route.agentId,
      lastRoutePolicy: deriveLastRoutePolicy({
        mainSessionKey: route.mainSessionKey,
        sessionKey: boundSessionKey,
      }),
      matchedBy: "binding.channel",
      sessionKey: boundSessionKey,
    };
    configuredBinding = null;
    getSessionBindingService().touch(boundConversation.bindingId);
    logVerbose(`line: routed via bound conversation ${peerId} -> ${boundSessionKey}`);
  }

  if (configuredBinding) {
    const ensured = await ensureConfiguredBindingRouteReady({
      bindingResolution: configuredBinding,
      cfg: params.cfg,
    });
    if (!ensured.ok) {
      logVerbose(
        `line: configured ACP binding unavailable for ${peerId} -> ${configuredBindingSessionKey}: ${ensured.error}`,
      );
      throw new Error(`Configured ACP binding unavailable: ${ensured.error}`);
    }
    logVerbose(
      `line: using configured ACP binding for ${peerId} -> ${configuredBindingSessionKey}`,
    );
  }

  return { groupId, isGroup, peerId, roomId, route, userId };
}

const STICKER_PACKAGES: Record<string, string> = {
  "1": "Moon & James",
  "11537": "Cony",
  "11538": "Brown",
  "11539": "Moon",
  "2": "Cony & Brown",
  "3": "Brown & Friends",
  "4": "Moon Special",
  "6136": "Cony's Happy Life",
  "6325": "Brown's Life",
  "6359": "Choco",
  "6362": "Sally",
  "6370": "Edward",
  "789": "LINE Characters",
};

function describeStickerKeywords(sticker: StickerEventMessage): string {
  const { keywords } = sticker as StickerEventMessage & { keywords?: string[] };
  if (keywords && keywords.length > 0) {
    return keywords.slice(0, 3).join(", ");
  }

  const stickerText = (sticker as StickerEventMessage & { text?: string }).text;
  if (stickerText) {
    return stickerText;
  }

  return "";
}

function extractMessageText(message: MessageEvent["message"]): string {
  if (message.type === "text") {
    return message.text;
  }
  if (message.type === "location") {
    const loc = message;
    return (
      formatLocationText({
        address: loc.address,
        latitude: loc.latitude,
        longitude: loc.longitude,
        name: loc.title,
      }) ?? ""
    );
  }
  if (message.type === "sticker") {
    const sticker = message;
    const packageName = STICKER_PACKAGES[sticker.packageId] ?? "sticker";
    const keywords = describeStickerKeywords(sticker);

    if (keywords) {
      return `[Sent a ${packageName} sticker: ${keywords}]`;
    }
    return `[Sent a ${packageName} sticker]`;
  }
  return "";
}

function extractMediaPlaceholder(message: MessageEvent["message"]): string {
  switch (message.type) {
    case "image": {
      return "<media:image>";
    }
    case "video": {
      return "<media:video>";
    }
    case "audio": {
      return "<media:audio>";
    }
    case "file": {
      return "<media:document>";
    }
    default: {
      return "";
    }
  }
}

type LineRouteInfo = ReturnType<typeof resolveAgentRoute>;
type LineSourceInfoWithPeerId = LineSourceInfo & { peerId: string };

function resolveLineConversationLabel(params: {
  isGroup: boolean;
  groupId?: string;
  roomId?: string;
  senderLabel: string;
}): string {
  return params.isGroup
    ? params.groupId
      ? `group:${params.groupId}`
      : params.roomId
        ? `room:${params.roomId}`
        : "unknown-group"
    : params.senderLabel;
}

function resolveLineAddresses(params: {
  isGroup: boolean;
  groupId?: string;
  roomId?: string;
  userId?: string;
  peerId: string;
}): { fromAddress: string; toAddress: string; originatingTo: string } {
  const fromAddress = params.isGroup
    ? params.groupId
      ? `line:group:${params.groupId}`
      : params.roomId
        ? `line:room:${params.roomId}`
        : `line:${params.peerId}`
    : `line:${params.userId ?? params.peerId}`;
  const toAddress = params.isGroup ? fromAddress : `line:${params.userId ?? params.peerId}`;
  const originatingTo = params.isGroup ? fromAddress : `line:${params.userId ?? params.peerId}`;
  return { fromAddress, originatingTo, toAddress };
}

async function finalizeLineInboundContext(params: {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  event: MessageEvent | PostbackEvent;
  route: LineRouteInfo;
  source: LineSourceInfoWithPeerId;
  rawBody: string;
  timestamp: number;
  messageSid: string;
  commandAuthorized: boolean;
  media: {
    firstPath: string | undefined;
    firstContentType?: string;
    paths?: string[];
    types?: string[];
  };
  locationContext?: ReturnType<typeof toLocationContext>;
  verboseLog: { kind: "inbound" | "postback"; mediaCount?: number };
  inboundHistory?: Pick<HistoryEntry, "sender" | "body" | "timestamp">[];
}) {
  const { fromAddress, toAddress, originatingTo } = resolveLineAddresses({
    groupId: params.source.groupId,
    isGroup: params.source.isGroup,
    peerId: params.source.peerId,
    roomId: params.source.roomId,
    userId: params.source.userId,
  });

  const senderId = params.source.userId ?? "unknown";
  const senderLabel = params.source.userId ? `user:${params.source.userId}` : "unknown";
  const conversationLabel = resolveLineConversationLabel({
    groupId: params.source.groupId,
    isGroup: params.source.isGroup,
    roomId: params.source.roomId,
    senderLabel,
  });

  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    agentId: params.route.agentId,
    cfg: params.cfg,
    sessionKey: params.route.sessionKey,
  });

  const body = formatInboundEnvelope({
    body: params.rawBody,
    channel: "LINE",
    chatType: params.source.isGroup ? "group" : "direct",
    envelope: envelopeOptions,
    from: conversationLabel,
    previousTimestamp,
    sender: {
      id: senderId,
    },
    timestamp: params.timestamp,
  });

  const ctxPayload = finalizeInboundContext({
    Body: body,
    BodyForAgent: params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.rawBody,
    From: fromAddress,
    To: toAddress,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId,
    ChatType: params.source.isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    GroupSubject: params.source.isGroup
      ? (params.source.groupId ?? params.source.roomId)
      : undefined,
    SenderId: senderId,
    Provider: "line",
    Surface: "line",
    MessageSid: params.messageSid,
    Timestamp: params.timestamp,
    MediaPath: params.media.firstPath,
    MediaType: params.media.firstContentType,
    MediaUrl: params.media.firstPath,
    MediaPaths: params.media.paths,
    MediaUrls: params.media.paths,
    MediaTypes: params.media.types,
    ...params.locationContext,
    CommandAuthorized: params.commandAuthorized,
    OriginatingChannel: "line" as const,
    OriginatingTo: originatingTo,
    GroupSystemPrompt: params.source.isGroup
      ? normalizeOptionalString(
          resolveLineGroupConfigEntry(params.account.config.groups, {
            groupId: params.source.groupId,
            roomId: params.source.roomId,
          })?.systemPrompt,
        )
      : undefined,
    InboundHistory: params.inboundHistory,
  });

  const pinnedMainDmOwner = !params.source.isGroup
    ? resolvePinnedMainDmOwnerFromAllowlist({
        allowFrom: params.account.config.allowFrom,
        dmScope: params.cfg.session?.dmScope,
        normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0],
      })
    : null;
  await recordInboundSession({
    ctx: ctxPayload,
    onRecordError: (err) => {
      logVerbose(`line: failed updating session meta: ${String(err)}`);
    },
    sessionKey: ctxPayload.SessionKey ?? params.route.sessionKey,
    storePath,
    updateLastRoute: !params.source.isGroup
      ? {
          accountId: params.route.accountId,
          channel: "line",
          mainDmOwnerPin:
            pinnedMainDmOwner && params.source.userId
              ? {
                  ownerRecipient: pinnedMainDmOwner,
                  senderRecipient: params.source.userId,
                  onSkip: ({ ownerRecipient, senderRecipient }) => {
                    logVerbose(
                      `line: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                    );
                  },
                }
              : undefined,
          sessionKey: params.route.mainSessionKey,
          to: params.source.userId ?? params.source.peerId,
        }
      : undefined,
  });

  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, String.raw`\n`);
    const mediaInfo =
      params.verboseLog.kind === "inbound" && (params.verboseLog.mediaCount ?? 0) > 1
        ? ` mediaCount=${params.verboseLog.mediaCount}`
        : "";
    const label = params.verboseLog.kind === "inbound" ? "line inbound" : "line postback";
    logVerbose(
      `${label}: from=${ctxPayload.From} len=${body.length}${mediaInfo} preview="${preview}"`,
    );
  }

  return { ctxPayload, replyToken: (params.event as { replyToken: string }).replyToken };
}

export async function buildLineMessageContext(params: BuildLineMessageContextParams) {
  const { event, allMedia, cfg, account, commandAuthorized, groupHistories, historyLimit } = params;

  const { source } = event;
  const { userId, groupId, roomId, isGroup, peerId, route } = await resolveLineInboundRoute({
    account,
    cfg,
    source,
  });

  const { message } = event;
  const messageId = message.id;
  const { timestamp } = event;

  const textContent = extractMessageText(message);
  const placeholder = extractMediaPlaceholder(message);

  let rawBody = textContent || placeholder;
  if (!rawBody && allMedia.length > 0) {
    rawBody = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
  }

  if (!rawBody && allMedia.length === 0) {
    return null;
  }

  let locationContext: ReturnType<typeof toLocationContext> | undefined;
  if (message.type === "location") {
    const loc = message;
    locationContext = toLocationContext({
      address: loc.address,
      latitude: loc.latitude,
      longitude: loc.longitude,
      name: loc.title,
    });
  }

  const historyKey = isGroup ? peerId : undefined;
  const inboundHistory =
    historyKey && groupHistories && (historyLimit ?? 0) > 0
      ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
          body: entry.body,
          sender: entry.sender,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const { ctxPayload } = await finalizeLineInboundContext({
    account,
    cfg,
    commandAuthorized,
    event,
    inboundHistory,
    locationContext,
    media: {
      firstContentType: allMedia[0]?.contentType,
      firstPath: allMedia[0]?.path,
      paths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
      types:
        allMedia.length > 0
          ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
          : undefined,
    },
    messageSid: messageId,
    rawBody,
    route,
    source: { groupId, isGroup, peerId, roomId, userId },
    timestamp,
    verboseLog: { kind: "inbound", mediaCount: allMedia.length },
  });

  return {
    accountId: account.accountId,
    ctxPayload,
    event,
    groupId,
    isGroup,
    replyToken: event.replyToken,
    roomId,
    route,
    userId,
  };
}

export async function buildLinePostbackContext(params: {
  event: PostbackEvent;
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  commandAuthorized: boolean;
}) {
  const { event, cfg, account, commandAuthorized } = params;

  const { source } = event;
  const { userId, groupId, roomId, isGroup, peerId, route } = await resolveLineInboundRoute({
    account,
    cfg,
    source,
  });

  const { timestamp } = event;
  const rawData = event.postback?.data?.trim() ?? "";
  if (!rawData) {
    return null;
  }
  let rawBody = rawData;
  if (rawData.includes("line.action=")) {
    const searchParams = new URLSearchParams(rawData);
    const action = searchParams.get("line.action") ?? "";
    const device = searchParams.get("line.device");
    rawBody = device ? `line action ${action} device ${device}` : `line action ${action}`;
  }

  const messageSid = event.replyToken ? `postback:${event.replyToken}` : `postback:${timestamp}`;
  const { ctxPayload } = await finalizeLineInboundContext({
    account,
    cfg,
    commandAuthorized,
    event,
    media: {
      firstContentType: undefined,
      firstPath: "",
      paths: undefined,
      types: undefined,
    },
    messageSid,
    rawBody,
    route,
    source: { groupId, isGroup, peerId, roomId, userId },
    timestamp,
    verboseLog: { kind: "postback" },
  });

  return {
    accountId: account.accountId,
    ctxPayload,
    event,
    groupId,
    isGroup,
    replyToken: event.replyToken,
    roomId,
    route,
    userId,
  };
}

export type LineMessageContext = NonNullable<Awaited<ReturnType<typeof buildLineMessageContext>>>;
export type LinePostbackContext = NonNullable<Awaited<ReturnType<typeof buildLinePostbackContext>>>;
export type LineInboundContext = LineMessageContext | LinePostbackContext;
