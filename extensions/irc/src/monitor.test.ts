import { describe, expect, it } from "vitest";
import { resolveIrcInboundTarget } from "./monitor.js";

describe("irc monitor inbound target", () => {
  it("keeps channel target for group messages", () => {
    expect(
      resolveIrcInboundTarget({
        senderNick: "alice",
        target: "#openclaw",
      }),
    ).toEqual({
      isGroup: true,
      rawTarget: "#openclaw",
      target: "#openclaw",
    });
  });

  it("maps DM target to sender nick and preserves raw target", () => {
    expect(
      resolveIrcInboundTarget({
        senderNick: "alice",
        target: "openclaw-bot",
      }),
    ).toEqual({
      isGroup: false,
      rawTarget: "openclaw-bot",
      target: "alice",
    });
  });

  it("falls back to raw target when sender nick is empty", () => {
    expect(
      resolveIrcInboundTarget({
        senderNick: " ",
        target: "openclaw-bot",
      }),
    ).toEqual({
      isGroup: false,
      rawTarget: "openclaw-bot",
      target: "openclaw-bot",
    });
  });
});
