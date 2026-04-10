import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readSlackMessages } from "./actions.js";

function createClient() {
  return {
    conversations: {
      history: vi.fn(async () => ({ has_more: false, messages: [] })),
      replies: vi.fn(async () => ({ has_more: false, messages: [] })),
    },
  } as unknown as WebClient & {
    conversations: {
      replies: ReturnType<typeof vi.fn>;
      history: ReturnType<typeof vi.fn>;
    };
  };
}

describe("readSlackMessages", () => {
  it("uses conversations.replies and drops the parent message", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      has_more: true,
      messages: [{ ts: "171234.567" }, { ts: "171234.890" }, { ts: "171235.000" }],
    });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "171234.567",
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      latest: undefined,
      limit: undefined,
      oldest: undefined,
      ts: "171234.567",
    });
    expect(client.conversations.history).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message.ts)).toEqual(["171234.890", "171235.000"]);
  });

  it("uses conversations.history when threadId is missing", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      has_more: false,
      messages: [{ ts: "1" }],
    });

    const result = await readSlackMessages("C1", {
      client,
      limit: 20,
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      latest: undefined,
      limit: 20,
      oldest: undefined,
    });
    expect(client.conversations.replies).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message.ts)).toEqual(["1"]);
  });
});
