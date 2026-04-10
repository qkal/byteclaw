import { describe, expect, it } from "vitest";
import { type FeishuMessageEvent, parseFeishuMessageEvent } from "./bot.js";

function makeEvent(
  text: string,
  mentions?: { key: string; name: string; id: { open_id?: string; user_id?: string } }[],
  chatType: "p2p" | "group" = "p2p",
): FeishuMessageEvent {
  return {
    message: {
      chat_id: "oc_chat1",
      chat_type: chatType,
      content: JSON.stringify({ text }),
      mentions,
      message_id: "msg_1",
      message_type: "text",
    },
    sender: { sender_id: { open_id: "ou_sender", user_id: "u1" } },
  };
}

const BOT_OPEN_ID = "ou_bot";

describe("normalizeMentions (via parseFeishuMessageEvent)", () => {
  it("returns original text when mentions are missing", () => {
    const ctx = parseFeishuMessageEvent(makeEvent("hello world", undefined), BOT_OPEN_ID);
    expect(ctx.content).toBe("hello world");
  });

  it("strips bot mention in p2p (addressing prefix, not semantic content)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 hello", [{ id: { open_id: "ou_bot" }, key: "@_bot_1", name: "Bot" }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("hello");
  });

  it("strips bot mention in group so slash commands work (#35994)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent(
        "@_bot_1 hello",
        [{ id: { open_id: "ou_bot" }, key: "@_bot_1", name: "Bot" }],
        "group",
      ),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("hello");
  });

  it("strips bot mention in group preserving slash command prefix (#35994)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent(
        "@_bot_1 /model",
        [{ id: { open_id: "ou_bot" }, key: "@_bot_1", name: "Bot" }],
        "group",
      ),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("/model");
  });

  it("strips bot mention but normalizes other mentions in p2p (mention-forward)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 @_user_alice hello", [
        { id: { open_id: "ou_bot" }, key: "@_bot_1", name: "Bot" },
        { id: { open_id: "ou_alice" }, key: "@_user_alice", name: "Alice" },
      ]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('<at user_id="ou_alice">Alice</at> hello');
  });

  it("falls back to @name when open_id is absent", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 hi", [{ id: { user_id: "uid_alice" }, key: "@_user_1", name: "Alice" }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("@Alice hi");
  });

  it("falls back to plain @name when no id is present", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_unknown hey", [{ id: {}, key: "@_unknown", name: "Nobody" }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("@Nobody hey");
  });

  it("treats mention key regex metacharacters as literal text", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("hello world", [{ id: { open_id: "ou_bot" }, key: ".*", name: "Bot" }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("hello world");
  });

  it("normalizes multiple mentions in one pass", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 hi @_user_2", [
        { id: { open_id: "ou_bot_1" }, key: "@_bot_1", name: "Bot One" },
        { id: { open_id: "ou_user_2" }, key: "@_user_2", name: "User Two" },
      ]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe(
      '<at user_id="ou_bot_1">Bot One</at> hi <at user_id="ou_user_2">User Two</at>',
    );
  });

  it("treats $ in display name as literal (no replacement-pattern interpolation)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 hi", [{ id: { open_id: "ou_x" }, key: "@_user_1", name: "$& the user" }]),
      BOT_OPEN_ID,
    );
    // $ is preserved literally (no $& pattern substitution); & is not escaped in tag body
    expect(ctx.content).toBe('<at user_id="ou_x">$& the user</at> hi');
  });

  it("escapes < and > in mention name to protect tag structure", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 test", [{ id: { open_id: "ou_x" }, key: "@_user_1", name: "<script>" }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('<at user_id="ou_x">&lt;script&gt;</at> test');
  });
});
