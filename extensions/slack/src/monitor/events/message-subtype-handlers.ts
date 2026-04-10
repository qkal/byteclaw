import type { SlackMessageEvent } from "../../types.js";
import type {
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackThreadBroadcastEvent,
} from "../types.js";

type SupportedSubtype = "message_changed" | "message_deleted" | "thread_broadcast";

export interface SlackMessageSubtypeHandler {
  subtype: SupportedSubtype;
  eventKind: SupportedSubtype;
  describe: (channelLabel: string) => string;
  contextKey: (event: SlackMessageEvent) => string;
  resolveSenderId: (event: SlackMessageEvent) => string | undefined;
  resolveChannelId: (event: SlackMessageEvent) => string | undefined;
  resolveChannelType: (event: SlackMessageEvent) => string | null | undefined;
}

const changedHandler: SlackMessageSubtypeHandler = {
  contextKey: (event) => {
    const changed = event as SlackMessageChangedEvent;
    const channelId = changed.channel ?? "unknown";
    const messageId =
      changed.message?.ts ?? changed.previous_message?.ts ?? changed.event_ts ?? "unknown";
    return `slack:message:changed:${channelId}:${messageId}`;
  },
  describe: (channelLabel) => `Slack message edited in ${channelLabel}.`,
  eventKind: "message_changed",
  resolveChannelId: (event) => (event as SlackMessageChangedEvent).channel,
  resolveChannelType: () => undefined,
  resolveSenderId: (event) => {
    const changed = event as SlackMessageChangedEvent;
    return (
      changed.message?.user ??
      changed.previous_message?.user ??
      changed.message?.bot_id ??
      changed.previous_message?.bot_id
    );
  },
  subtype: "message_changed",
};

const deletedHandler: SlackMessageSubtypeHandler = {
  contextKey: (event) => {
    const deleted = event as SlackMessageDeletedEvent;
    const channelId = deleted.channel ?? "unknown";
    const messageId = deleted.deleted_ts ?? deleted.event_ts ?? "unknown";
    return `slack:message:deleted:${channelId}:${messageId}`;
  },
  describe: (channelLabel) => `Slack message deleted in ${channelLabel}.`,
  eventKind: "message_deleted",
  resolveChannelId: (event) => (event as SlackMessageDeletedEvent).channel,
  resolveChannelType: () => undefined,
  resolveSenderId: (event) => {
    const deleted = event as SlackMessageDeletedEvent;
    return deleted.previous_message?.user ?? deleted.previous_message?.bot_id;
  },
  subtype: "message_deleted",
};

const threadBroadcastHandler: SlackMessageSubtypeHandler = {
  contextKey: (event) => {
    const thread = event as SlackThreadBroadcastEvent;
    const channelId = thread.channel ?? "unknown";
    const messageId = thread.message?.ts ?? thread.event_ts ?? "unknown";
    return `slack:thread:broadcast:${channelId}:${messageId}`;
  },
  describe: (channelLabel) => `Slack thread reply broadcast in ${channelLabel}.`,
  eventKind: "thread_broadcast",
  resolveChannelId: (event) => (event as SlackThreadBroadcastEvent).channel,
  resolveChannelType: () => undefined,
  resolveSenderId: (event) => {
    const thread = event as SlackThreadBroadcastEvent;
    return thread.user ?? thread.message?.user ?? thread.message?.bot_id;
  },
  subtype: "thread_broadcast",
};

const SUBTYPE_HANDLER_REGISTRY: Record<SupportedSubtype, SlackMessageSubtypeHandler> = {
  message_changed: changedHandler,
  message_deleted: deletedHandler,
  thread_broadcast: threadBroadcastHandler,
};

export function resolveSlackMessageSubtypeHandler(
  event: SlackMessageEvent,
): SlackMessageSubtypeHandler | undefined {
  const {subtype} = event;
  if (
    subtype !== "message_changed" &&
    subtype !== "message_deleted" &&
    subtype !== "thread_broadcast"
  ) {
    return undefined;
  }
  return SUBTYPE_HANDLER_REGISTRY[subtype];
}
