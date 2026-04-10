import { describe, expect, it } from "vitest";
import { summarizeMatrixRawEvent } from "./summary.js";

describe("summarizeMatrixRawEvent", () => {
  it("replaces bare media filenames with a media marker", () => {
    const summary = summarizeMatrixRawEvent({
      content: {
        body: "photo.jpg",
        msgtype: "m.image",
      },
      event_id: "$image",
      origin_server_ts: 123,
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
    });

    expect(summary).toMatchObject({
      attachment: {
        filename: "photo.jpg",
        kind: "image",
      },
      eventId: "$image",
      msgtype: "m.image",
    });
    expect(summary.body).toBeUndefined();
  });

  it("preserves captions while marking media summaries", () => {
    const summary = summarizeMatrixRawEvent({
      content: {
        body: "can you see this?",
        filename: "photo.jpg",
        msgtype: "m.image",
      },
      event_id: "$image",
      origin_server_ts: 123,
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
    });

    expect(summary).toMatchObject({
      attachment: {
        caption: "can you see this?",
        filename: "photo.jpg",
        kind: "image",
      },
      body: "can you see this?",
    });
  });

  it("does not treat a sentence ending in a file extension as a bare filename", () => {
    const summary = summarizeMatrixRawEvent({
      content: {
        body: "see image.png",
        msgtype: "m.image",
      },
      event_id: "$image",
      origin_server_ts: 123,
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
    });

    expect(summary).toMatchObject({
      attachment: {
        caption: "see image.png",
        kind: "image",
      },
      body: "see image.png",
    });
  });

  it("leaves text messages unchanged", () => {
    const summary = summarizeMatrixRawEvent({
      content: {
        body: "hello",
        msgtype: "m.text",
      },
      event_id: "$text",
      origin_server_ts: 123,
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
    });

    expect(summary.body).toBe("hello");
    expect(summary.attachment).toBeUndefined();
  });
});
