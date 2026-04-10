import { Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { createDiscordDraftStream } from "./draft-stream.js";

describe("createDiscordDraftStream", () => {
  it("holds the first preview until minInitialChars is reached", async () => {
    const rest = {
      delete: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      post: vi.fn(async () => ({ id: "m1" })),
    };
    const stream = createDiscordDraftStream({
      channelId: "c1",
      minInitialChars: 5,
      rest: rest as never,
      throttleMs: 250,
    });

    stream.update("hey");
    await stream.flush();

    expect(rest.post).not.toHaveBeenCalled();
    expect(stream.messageId()).toBeUndefined();
  });

  it("sends a reply preview, then edits the same message on later flushes", async () => {
    const rest = {
      delete: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      post: vi.fn(async () => ({ id: "m1" })),
    };
    const stream = createDiscordDraftStream({
      channelId: "c1",
      replyToMessageId: () => "  parent-1  ",
      rest: rest as never,
      throttleMs: 250,
    });

    stream.update("first draft");
    await stream.flush();
    stream.update("second draft");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledWith(Routes.channelMessages("c1"), {
      body: {
        content: "first draft",
        message_reference: {
          fail_if_not_exists: false,
          message_id: "parent-1",
        },
      },
    });
    expect(rest.patch).toHaveBeenCalledWith(Routes.channelMessage("c1", "m1"), {
      body: { content: "second draft" },
    });
    expect(stream.messageId()).toBe("m1");
  });

  it("stops previewing and warns once text exceeds the configured limit", async () => {
    const rest = {
      delete: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      post: vi.fn(async () => ({ id: "m1" })),
    };
    const warn = vi.fn();
    const stream = createDiscordDraftStream({
      channelId: "c1",
      maxChars: 5,
      rest: rest as never,
      throttleMs: 250,
      warn,
    });

    stream.update("123456");
    await stream.flush();

    expect(rest.post).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("discord stream preview stopped"));
    expect(stream.messageId()).toBeUndefined();
  });
});
