import type { CoreConfig } from "../../types.js";
import {
  MATRIX_ANNOTATION_RELATION_TYPE,
  MATRIX_REACTION_EVENT_TYPE,
  type MatrixReactionEventContent,
} from "../reaction-common.js";
import type { MatrixClient, MessageEventContent } from "../sdk.js";
export type { MatrixRawEvent } from "../sdk.js";
export type { MatrixReactionSummary } from "../reaction-common.js";

export const MsgType = {
  Text: "m.text",
} as const;

export const RelationType = {
  Annotation: MATRIX_ANNOTATION_RELATION_TYPE,
  Replace: "m.replace",
} as const;

export const EventType = {
  Reaction: MATRIX_REACTION_EVENT_TYPE,
  RoomMessage: "m.room.message",
  RoomPinnedEvents: "m.room.pinned_events",
  RoomTopic: "m.room.topic",
} as const;

export type RoomMessageEventContent = MessageEventContent & {
  msgtype: string;
  body: string;
  "m.new_content"?: RoomMessageEventContent;
  "m.relates_to"?: {
    rel_type?: string;
    event_id?: string;
    "m.in_reply_to"?: { event_id?: string };
  };
};

export type ReactionEventContent = MatrixReactionEventContent;

export interface RoomPinnedEventsEventContent {
  pinned: string[];
}

export interface RoomTopicEventContent {
  topic?: string;
}

export interface MatrixActionClientOpts {
  client?: MatrixClient;
  cfg?: CoreConfig;
  mediaLocalRoots?: readonly string[];
  timeoutMs?: number;
  accountId?: string | null;
  readiness?: "none" | "prepared" | "started";
}

export interface MatrixMessageSummary {
  eventId?: string;
  sender?: string;
  body?: string;
  msgtype?: string;
  attachment?: MatrixMessageAttachmentSummary;
  timestamp?: number;
  relatesTo?: {
    relType?: string;
    eventId?: string;
    key?: string;
  };
}

export type MatrixMessageAttachmentKind = "audio" | "file" | "image" | "sticker" | "video";

export interface MatrixMessageAttachmentSummary {
  kind: MatrixMessageAttachmentKind;
  caption?: string;
  filename?: string;
}

export interface MatrixActionClient {
  client: MatrixClient;
  stopOnDone: boolean;
}
