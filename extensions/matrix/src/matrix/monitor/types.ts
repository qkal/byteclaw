import { MATRIX_REACTION_EVENT_TYPE } from "../reaction-common.js";
import type { EncryptedFile, MessageEventContent } from "../sdk.js";
export type { MatrixRawEvent } from "../sdk.js";

export const EventType = {
  Location: "m.location",
  Reaction: MATRIX_REACTION_EVENT_TYPE,
  RoomMember: "m.room.member",
  RoomMessage: "m.room.message",
  RoomMessageEncrypted: "m.room.encrypted",
} as const;

export const RelationType = {
  Replace: "m.replace",
  Thread: "m.thread",
} as const;

export type RoomMessageEventContent = MessageEventContent & {
  url?: string;
  file?: EncryptedFile;
  info?: {
    mimetype?: string;
    size?: number;
  };
  "m.relates_to"?: {
    rel_type?: string;
    event_id?: string;
    "m.in_reply_to"?: { event_id?: string };
  };
};
