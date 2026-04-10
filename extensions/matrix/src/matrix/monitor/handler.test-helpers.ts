import { vi } from "vitest";
import type { RuntimeEnv, RuntimeLogger } from "../../runtime-api.js";
import type { MatrixRoomConfig, MatrixStreamingMode, ReplyToMode } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { type MatrixMonitorHandlerParams, createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent, type RoomMessageEventContent } from "./types.js";

const DEFAULT_ROUTE = {
  accountId: "ops",
  agentId: "ops",
  channel: "matrix",
  mainSessionKey: "agent:ops:main",
  matchedBy: "binding.account" as const,
  sessionKey: "agent:ops:main",
};

interface MatrixHandlerTestHarnessOptions {
  accountId?: string;
  cfg?: unknown;
  client?: Partial<MatrixClient>;
  runtime?: RuntimeEnv;
  logger?: RuntimeLogger;
  logVerboseMessage?: (message: string) => void;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  roomsConfig?: Record<string, MatrixRoomConfig>;
  accountAllowBots?: boolean | "mentions";
  configuredBotUserIds?: Set<string>;
  mentionRegexes?: RegExp[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  replyToMode?: ReplyToMode;
  threadReplies?: "off" | "inbound" | "always";
  dmThreadReplies?: "off" | "inbound" | "always";
  dmSessionScope?: "per-user" | "per-room";
  streaming?: MatrixStreamingMode;
  blockStreamingEnabled?: boolean;
  dmEnabled?: boolean;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  textLimit?: number;
  mediaMaxBytes?: number;
  startupMs?: number;
  startupGraceMs?: number;
  dropPreStartupMessages?: boolean;
  needsRoomAliasesForConfig?: boolean;
  isDirectMessage?: boolean;
  historyLimit?: number;
  readAllowFromStore?: MatrixMonitorHandlerParams["core"]["channel"]["pairing"]["readAllowFromStore"];
  upsertPairingRequest?: MatrixMonitorHandlerParams["core"]["channel"]["pairing"]["upsertPairingRequest"];
  buildPairingReply?: () => string;
  shouldHandleTextCommands?: () => boolean;
  hasControlCommand?: () => boolean;
  resolveMarkdownTableMode?: () => string;
  resolveAgentRoute?: () => typeof DEFAULT_ROUTE;
  resolveStorePath?: () => string;
  readSessionUpdatedAt?: () => number | undefined;
  recordInboundSession?: (...args: unknown[]) => Promise<void>;
  resolveEnvelopeFormatOptions?: () => Record<string, never>;
  formatAgentEnvelope?: ({ body }: { body: string }) => string;
  finalizeInboundContext?: (ctx: unknown) => unknown;
  createReplyDispatcherWithTyping?: (params?: {
    onError?: (err: unknown, info: { kind: "tool" | "block" | "final" }) => void;
  }) => {
    dispatcher: Record<string, unknown>;
    replyOptions: Record<string, unknown>;
    markDispatchIdle: () => void;
    markRunComplete: () => void;
  };
  resolveHumanDelayConfig?: () => undefined;
  dispatchReplyFromConfig?: () => Promise<{
    queuedFinal: boolean;
    counts: { final: number; block: number; tool: number };
  }>;
  withReplyDispatcher?: <T>(params: {
    dispatcher: {
      markComplete?: () => void;
      waitForIdle?: () => Promise<void>;
    };
    run: () => Promise<T>;
    onSettled?: () => void | Promise<void>;
  }) => Promise<T>;
  inboundDeduper?: MatrixMonitorHandlerParams["inboundDeduper"];
  shouldAckReaction?: () => boolean;
  enqueueSystemEvent?: (...args: unknown[]) => void;
  getRoomInfo?: MatrixMonitorHandlerParams["getRoomInfo"];
  getMemberDisplayName?: MatrixMonitorHandlerParams["getMemberDisplayName"];
}

interface MatrixHandlerTestHarness {
  dispatchReplyFromConfig: () => Promise<{
    queuedFinal: boolean;
    counts: { final: number; block: number; tool: number };
  }>;
  enqueueSystemEvent: (...args: unknown[]) => void;
  finalizeInboundContext: (ctx: unknown) => unknown;
  handler: ReturnType<typeof createMatrixRoomMessageHandler>;
  readAllowFromStore: MatrixMonitorHandlerParams["core"]["channel"]["pairing"]["readAllowFromStore"];
  recordInboundSession: (...args: unknown[]) => Promise<void>;
  resolveAgentRoute: () => typeof DEFAULT_ROUTE;
  upsertPairingRequest: MatrixMonitorHandlerParams["core"]["channel"]["pairing"]["upsertPairingRequest"];
}

export function createMatrixHandlerTestHarness(
  options: MatrixHandlerTestHarnessOptions = {},
): MatrixHandlerTestHarness {
  const readAllowFromStore = options.readAllowFromStore ?? vi.fn(async () => [] as string[]);
  const upsertPairingRequest =
    options.upsertPairingRequest ?? vi.fn(async () => ({ code: "ABCDEFGH", created: false }));
  const resolveAgentRoute = options.resolveAgentRoute ?? vi.fn(() => DEFAULT_ROUTE);
  const recordInboundSession = options.recordInboundSession ?? vi.fn(async () => {});
  const finalizeInboundContext = options.finalizeInboundContext ?? vi.fn((ctx) => ctx);
  const dispatchReplyFromConfig =
    options.dispatchReplyFromConfig ??
    (async () => ({
      counts: { block: 0, final: 0, tool: 0 },
      queuedFinal: false,
    }));
  const enqueueSystemEvent = options.enqueueSystemEvent ?? vi.fn();

  const handler = createMatrixRoomMessageHandler({
    accountAllowBots: options.accountAllowBots,
    accountId: options.accountId ?? "ops",
    allowFrom: options.allowFrom ?? [],
    blockStreamingEnabled: options.blockStreamingEnabled ?? false,
    cfg: (options.cfg ?? {}) as never,
    client: {
      getEvent: async () => ({ sender: "@bot:example.org" }),
      getUserId: async () => "@bot:example.org",
      ...options.client,
    } as never,
    configuredBotUserIds: options.configuredBotUserIds,
    core: {
      channel: {
        commands: {
          shouldHandleTextCommands: options.shouldHandleTextCommands ?? (() => false),
        },
        mentions: {
          buildMentionRegexes: () => options.mentionRegexes ?? [],
        },
        pairing: {
          buildPairingReply: options.buildPairingReply ?? (() => "pairing"),
          readAllowFromStore,
          upsertPairingRequest,
        },
        reactions: {
          shouldAckReaction: options.shouldAckReaction ?? (() => false),
        },
        reply: {
          createReplyDispatcherWithTyping:
            options.createReplyDispatcherWithTyping ??
            (() => ({
              dispatcher: {},
              replyOptions: {},
              markDispatchIdle: () => {},
              markRunComplete: () => {},
            })),
          dispatchReplyFromConfig,
          finalizeInboundContext,
          formatAgentEnvelope:
            options.formatAgentEnvelope ?? (({ body }: { body: string }) => body),
          resolveEnvelopeFormatOptions: options.resolveEnvelopeFormatOptions ?? (() => ({})),
          resolveHumanDelayConfig: options.resolveHumanDelayConfig ?? (() => undefined),
          withReplyDispatcher:
            options.withReplyDispatcher ??
            (async <T>(params: {
              dispatcher: {
                markComplete?: () => void;
                waitForIdle?: () => Promise<void>;
              };
              run: () => Promise<T>;
              onSettled?: () => void | Promise<void>;
            }) => {
              const { dispatcher, run, onSettled } = params;
              try {
                return await run();
              } finally {
                dispatcher.markComplete?.();
                try {
                  await dispatcher.waitForIdle?.();
                } finally {
                  await onSettled?.();
                }
              }
            }),
        },
        routing: {
          resolveAgentRoute,
        },
        session: {
          readSessionUpdatedAt: options.readSessionUpdatedAt ?? (() => undefined),
          recordInboundSession,
          resolveStorePath: options.resolveStorePath ?? (() => "/tmp/session-store"),
        },
        text: {
          hasControlCommand: options.hasControlCommand ?? (() => false),
          resolveMarkdownTableMode: options.resolveMarkdownTableMode ?? (() => "preserve"),
        },
      },
      system: {
        enqueueSystemEvent,
      },
    } as never,
    directTracker: {
      isDirectMessage: async () => options.isDirectMessage ?? true,
    },
    dmEnabled: options.dmEnabled ?? true,
    dmPolicy: options.dmPolicy ?? "open",
    dmSessionScope: options.dmSessionScope,
    dmThreadReplies: options.dmThreadReplies,
    dropPreStartupMessages: options.dropPreStartupMessages ?? true,
    getMemberDisplayName: options.getMemberDisplayName ?? (async () => "sender"),
    getRoomInfo: options.getRoomInfo ?? (async () => ({ altAliases: [] })),
    groupAllowFrom: options.groupAllowFrom ?? [],
    groupPolicy: options.groupPolicy ?? "open",
    historyLimit: options.historyLimit ?? 0,
    inboundDeduper: options.inboundDeduper,
    logVerboseMessage: options.logVerboseMessage ?? (() => {}),
    logger:
      options.logger ??
      ({
        error: () => {},
        info: () => {},
        warn: () => {},
      } as RuntimeLogger),
    mediaMaxBytes: options.mediaMaxBytes ?? 10_000_000,
    needsRoomAliasesForConfig: options.needsRoomAliasesForConfig ?? false,
    replyToMode: options.replyToMode ?? "off",
    roomsConfig: options.roomsConfig,
    runtime:
      options.runtime ??
      ({
        error: () => {},
      } as RuntimeEnv),
    startupGraceMs: options.startupGraceMs ?? 0,
    startupMs: options.startupMs ?? 0,
    streaming: options.streaming ?? "off",
    textLimit: options.textLimit ?? 8000,
    threadReplies: options.threadReplies ?? "inbound",
  });

  return {
    dispatchReplyFromConfig,
    enqueueSystemEvent,
    finalizeInboundContext,
    handler,
    readAllowFromStore,
    recordInboundSession,
    resolveAgentRoute,
    upsertPairingRequest,
  };
}

export function createMatrixTextMessageEvent(params: {
  eventId: string;
  sender?: string;
  body: string;
  originServerTs?: number;
  relatesTo?: RoomMessageEventContent["m.relates_to"];
  mentions?: RoomMessageEventContent["m.mentions"];
}): MatrixRawEvent {
  return createMatrixRoomMessageEvent({
    content: {
      body: params.body,
      msgtype: "m.text",
      ...(params.relatesTo ? { "m.relates_to": params.relatesTo } : {}),
      ...(params.mentions ? { "m.mentions": params.mentions } : {}),
    },
    eventId: params.eventId,
    originServerTs: params.originServerTs,
    sender: params.sender,
  });
}

export function createMatrixRoomMessageEvent(params: {
  eventId: string;
  sender?: string;
  originServerTs?: number;
  content: RoomMessageEventContent;
}): MatrixRawEvent {
  return {
    content: params.content,
    event_id: params.eventId,
    origin_server_ts: params.originServerTs ?? Date.now(),
    sender: params.sender ?? "@user:example.org",
    type: EventType.RoomMessage,
  } as MatrixRawEvent;
}

export function createMatrixReactionEvent(params: {
  eventId: string;
  targetEventId: string;
  key: string;
  sender?: string;
  originServerTs?: number;
}): MatrixRawEvent {
  return {
    content: {
      "m.relates_to": {
        event_id: params.targetEventId,
        key: params.key,
        rel_type: "m.annotation",
      },
    },
    event_id: params.eventId,
    origin_server_ts: params.originServerTs ?? Date.now(),
    sender: params.sender ?? "@user:example.org",
    type: EventType.Reaction,
  } as MatrixRawEvent;
}
