import { isMatrixNotFoundError } from "../errors.js";
import { resolveMatrixMessageAttachment, resolveMatrixMessageBody } from "../media-text.js";
import { fetchMatrixPollMessageSummary } from "../poll-summary.js";
import type { MatrixClient } from "../sdk.js";
import {
  EventType,
  type MatrixMessageSummary,
  type MatrixRawEvent,
  type RoomMessageEventContent,
  type RoomPinnedEventsEventContent,
} from "./types.js";

export function summarizeMatrixRawEvent(event: MatrixRawEvent): MatrixMessageSummary {
  const content = event.content as RoomMessageEventContent;
  const relates = content["m.relates_to"];
  let relType: string | undefined;
  let eventId: string | undefined;
  if (relates) {
    if ("rel_type" in relates) {
      relType = relates.rel_type;
      eventId = relates.event_id;
    } else if ("m.in_reply_to" in relates) {
      eventId = relates["m.in_reply_to"]?.event_id;
    }
  }
  const relatesTo =
    relType || eventId
      ? {
          eventId,
          relType,
        }
      : undefined;
  return {
    attachment: resolveMatrixMessageAttachment({
      body: content.body,
      filename: content.filename,
      msgtype: content.msgtype,
    }),
    body: resolveMatrixMessageBody({
      body: content.body,
      filename: content.filename,
      msgtype: content.msgtype,
    }),
    eventId: event.event_id,
    msgtype: content.msgtype,
    relatesTo,
    sender: event.sender,
    timestamp: event.origin_server_ts,
  };
}

export async function readPinnedEvents(client: MatrixClient, roomId: string): Promise<string[]> {
  try {
    const content = (await client.getRoomStateEvent(
      roomId,
      EventType.RoomPinnedEvents,
      "",
    )) as RoomPinnedEventsEventContent;
    const {pinned} = content;
    return pinned.filter((id) => id.trim().length > 0);
  } catch (error: unknown) {
    if (isMatrixNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

export async function fetchEventSummary(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<MatrixMessageSummary | null> {
  try {
    const raw = (await client.getEvent(roomId, eventId)) as unknown as MatrixRawEvent;
    if (raw.unsigned?.redacted_because) {
      return null;
    }
    const pollSummary = await fetchMatrixPollMessageSummary(client, roomId, raw);
    if (pollSummary) {
      return pollSummary;
    }
    return summarizeMatrixRawEvent(raw);
  } catch {
    // Event not found, redacted, or inaccessible - return null
    return null;
  }
}
