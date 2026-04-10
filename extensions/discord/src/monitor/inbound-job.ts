import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

type DiscordInboundJobRuntimeField =
  | "runtime"
  | "abortSignal"
  | "guildHistories"
  | "client"
  | "threadBindings"
  | "discordRestFetch";

export type DiscordInboundJobRuntime = Pick<
  DiscordMessagePreflightContext,
  DiscordInboundJobRuntimeField
>;

export type DiscordInboundJobPayload = Omit<
  DiscordMessagePreflightContext,
  DiscordInboundJobRuntimeField
>;

export interface DiscordInboundJob {
  queueKey: string;
  payload: DiscordInboundJobPayload;
  runtime: DiscordInboundJobRuntime;
}

export function resolveDiscordInboundJobQueueKey(ctx: DiscordMessagePreflightContext): string {
  const sessionKey = ctx.route.sessionKey?.trim();
  if (sessionKey) {
    return sessionKey;
  }
  const baseSessionKey = ctx.baseSessionKey?.trim();
  if (baseSessionKey) {
    return baseSessionKey;
  }
  return ctx.messageChannelId;
}

export function buildDiscordInboundJob(ctx: DiscordMessagePreflightContext): DiscordInboundJob {
  const {
    runtime,
    abortSignal,
    guildHistories,
    client,
    threadBindings,
    discordRestFetch,
    message,
    data,
    threadChannel,
    ...payload
  } = ctx;

  const sanitizedMessage = sanitizeDiscordInboundMessage(message);
  return {
    payload: {
      ...payload,
      data: {
        ...data,
        message: sanitizedMessage,
      },
      message: sanitizedMessage,
      threadChannel: normalizeDiscordThreadChannel(threadChannel),
    },
    queueKey: resolveDiscordInboundJobQueueKey(ctx),
    runtime: {
      abortSignal,
      client,
      discordRestFetch,
      guildHistories,
      runtime,
      threadBindings,
    },
  };
}

export function materializeDiscordInboundJob(
  job: DiscordInboundJob,
  abortSignal?: AbortSignal,
): DiscordMessagePreflightContext {
  return {
    ...job.payload,
    ...job.runtime,
    abortSignal: abortSignal ?? job.runtime.abortSignal,
  };
}

function sanitizeDiscordInboundMessage<T extends object>(message: T): T {
  const descriptors = Object.getOwnPropertyDescriptors(message);
  delete descriptors.channel;
  return Object.create(Object.getPrototypeOf(message), descriptors) as T;
}

function normalizeDiscordThreadChannel(
  threadChannel: DiscordMessagePreflightContext["threadChannel"],
): DiscordMessagePreflightContext["threadChannel"] {
  if (!threadChannel) {
    return null;
  }
  return {
    id: threadChannel.id,
    name: threadChannel.name,
    ownerId: threadChannel.ownerId,
    parent: threadChannel.parent
      ? {
          id: threadChannel.parent.id,
          name: threadChannel.parent.name,
        }
      : undefined,
    parentId: threadChannel.parentId,
  };
}
