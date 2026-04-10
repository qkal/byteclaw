import { describe, expect, it } from "vitest";
import { parseIMessageNotification } from "./parse-notification.js";

describe("parseIMessageNotification", () => {
  it("strips a length-delimited field wrapper from text and reply_to_text", () => {
    const wrappedText = `${String.fromCharCode(0x0A, 11)}hello world`;
    const wrappedReply = `${String.fromCharCode(0x0A, 5)}quote`;
    const raw = {
      message: {
        attachments: null,
        chat_guid: null,
        chat_id: 2,
        chat_identifier: null,
        chat_name: null,
        created_at: null,
        destination_caller_id: null,
        guid: "g",
        id: 1,
        is_from_me: false,
        is_group: false,
        participants: null,
        reply_to_id: null,
        reply_to_sender: null,
        reply_to_text: wrappedReply,
        sender: "+10000000000",
        text: wrappedText,
      },
    };

    const parsed = parseIMessageNotification(raw);
    expect(parsed?.text).toBe("hello world");
    expect(parsed?.reply_to_text).toBe("quote");
  });
});
