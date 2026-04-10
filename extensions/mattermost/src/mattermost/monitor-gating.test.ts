import { describe, expect, it, vi } from "vitest";
import {
  evaluateMattermostMentionGate,
  mapMattermostChannelTypeToChatType,
} from "./monitor-gating.js";

describe("mattermost monitor gating", () => {
  it("maps mattermost channel types to chat types", () => {
    expect(mapMattermostChannelTypeToChatType("D")).toBe("direct");
    expect(mapMattermostChannelTypeToChatType("G")).toBe("group");
    expect(mapMattermostChannelTypeToChatType("P")).toBe("group");
    expect(mapMattermostChannelTypeToChatType("O")).toBe("channel");
    expect(mapMattermostChannelTypeToChatType(undefined)).toBe("channel");
  });

  it("drops non-mentioned traffic when onchar is enabled but not triggered", () => {
    const resolveRequireMention = vi.fn(() => true);

    expect(
      evaluateMattermostMentionGate({
        accountId: "default",
        canDetectMention: true,
        cfg: {} as never,
        channelId: "chan-1",
        commandAuthorized: false,
        isControlCommand: false,
        kind: "channel",
        oncharEnabled: true,
        oncharTriggered: false,
        resolveRequireMention,
        wasMentioned: false,
      }),
    ).toEqual({
      dropReason: "onchar-not-triggered",
      effectiveWasMentioned: false,
      shouldBypassMention: false,
      shouldRequireMention: true,
    });
  });

  it("bypasses mention for authorized control commands and allows direct chats", () => {
    const resolveRequireMention = vi.fn(() => true);

    expect(
      evaluateMattermostMentionGate({
        accountId: "default",
        canDetectMention: true,
        cfg: {} as never,
        channelId: "chan-1",
        commandAuthorized: true,
        isControlCommand: true,
        kind: "channel",
        oncharEnabled: false,
        oncharTriggered: false,
        resolveRequireMention,
        wasMentioned: false,
      }),
    ).toEqual({
      dropReason: null,
      effectiveWasMentioned: true,
      shouldBypassMention: true,
      shouldRequireMention: true,
    });

    expect(
      evaluateMattermostMentionGate({
        accountId: "default",
        canDetectMention: true,
        cfg: {} as never,
        channelId: "chan-1",
        commandAuthorized: false,
        isControlCommand: false,
        kind: "direct",
        oncharEnabled: false,
        oncharTriggered: false,
        resolveRequireMention,
        wasMentioned: false,
      }),
    ).toMatchObject({
      dropReason: null,
      shouldRequireMention: false,
    });
  });
});
