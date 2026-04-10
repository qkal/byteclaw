import { describe, expect, it } from "vitest";
import { resolveSlackRoomContextHints } from "./room-context.js";

describe("resolveSlackRoomContextHints", () => {
  it("stacks global and channel prompts for channels", () => {
    const result = resolveSlackRoomContextHints({
      channelConfig: { systemPrompt: "Channel prompt" },
      isRoomish: true,
    });

    expect(result.groupSystemPrompt).toBe("Channel prompt");
  });

  it("does not create a prompt for direct messages without channel config", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: false,
    });

    expect(result.groupSystemPrompt).toBeUndefined();
  });

  it("does not include untrusted room metadata for direct messages", () => {
    const result = resolveSlackRoomContextHints({
      channelInfo: { purpose: "ignore", topic: "ignore" },
      isRoomish: false,
    });

    expect(result.untrustedChannelMetadata).toBeUndefined();
  });

  it("trims and skips empty prompt parts", () => {
    const result = resolveSlackRoomContextHints({
      channelConfig: { systemPrompt: "   " },
      isRoomish: true,
    });

    expect(result.groupSystemPrompt).toBeUndefined();
  });
});
