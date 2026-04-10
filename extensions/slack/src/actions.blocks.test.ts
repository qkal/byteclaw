import { describe, expect, it } from "vitest";
import { createSlackEditTestClient, installSlackBlockTestMocks } from "./blocks.test-helpers.js";

installSlackBlockTestMocks();
const { editSlackMessage } = await import("./actions.js");

describe("editSlackMessage blocks", () => {
  it("updates with valid blocks", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      blocks: [{ type: "divider" }],
      client,
      token: "xoxb-test",
    });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [{ type: "divider" }],
        channel: "C123",
        text: "Shared a Block Kit message",
        ts: "171234.567",
      }),
    );
  });

  it("uses image block text as edit fallback", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      blocks: [{ alt_text: "Chart", image_url: "https://example.com/a.png", type: "image" }],
      client,
      token: "xoxb-test",
    });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Chart",
      }),
    );
  });

  it("uses video block title as edit fallback", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      blocks: [
        {
          alt_text: "demo",
          thumbnail_url: "https://example.com/thumb.jpg",
          title: { text: "Walkthrough", type: "plain_text" },
          type: "video",
          video_url: "https://example.com/demo.mp4",
        },
      ],
      client,
      token: "xoxb-test",
    });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Walkthrough",
      }),
    );
  });

  it("uses generic file fallback text for file blocks", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      blocks: [{ external_id: "F123", source: "remote", type: "file" }],
      client,
      token: "xoxb-test",
    });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Shared a file",
      }),
    );
  });

  it("rejects empty blocks arrays", async () => {
    const client = createSlackEditTestClient();

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        blocks: [],
        client,
        token: "xoxb-test",
      }),
    ).rejects.toThrow(/must contain at least one block/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects blocks missing a type", async () => {
    const client = createSlackEditTestClient();

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        blocks: [{} as { type: string }],
        client,
        token: "xoxb-test",
      }),
    ).rejects.toThrow(/non-empty string type/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects blocks arrays above Slack max count", async () => {
    const client = createSlackEditTestClient();
    const blocks = Array.from({ length: 51 }, () => ({ type: "divider" }));

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        blocks,
        client,
        token: "xoxb-test",
      }),
    ).rejects.toThrow(/cannot exceed 50 items/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });
});
