import { describe, expect, it, vi } from "vitest";
import {
  removeAckReactionAfterReply,
  shouldAckReaction,
  shouldAckReactionForWhatsApp,
} from "./ack-reactions.js";

const flushMicrotasks = async () => {
  await Promise.resolve();
};

describe("shouldAckReaction", () => {
  it("honors direct and group-all scopes", () => {
    expect(
      shouldAckReaction({
        canDetectMention: false,
        effectiveWasMentioned: false,
        isDirect: true,
        isGroup: false,
        isMentionableGroup: false,
        requireMention: false,
        scope: "direct",
      }),
    ).toBe(true);

    expect(
      shouldAckReaction({
        canDetectMention: false,
        effectiveWasMentioned: false,
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: false,
        scope: "group-all",
      }),
    ).toBe(true);
  });

  it("skips when scope is off", () => {
    expect(
      shouldAckReaction({
        canDetectMention: true,
        effectiveWasMentioned: true,
        isDirect: true,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        scope: "off",
      }),
    ).toBe(false);
  });

  it("defaults to group-mentions gating", () => {
    expect(
      shouldAckReaction({
        canDetectMention: true,
        effectiveWasMentioned: true,
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        scope: undefined,
      }),
    ).toBe(true);
  });

  it("requires mention gating for group-mentions", () => {
    const groupMentionsScope = {
      canDetectMention: true,
      effectiveWasMentioned: true,
      isDirect: false,
      isGroup: true,
      isMentionableGroup: true,
      requireMention: true,
      scope: "group-mentions" as const,
    };

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        requireMention: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        canDetectMention: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        isMentionableGroup: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
      }),
    ).toBe(true);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        effectiveWasMentioned: false,
        shouldBypassMention: true,
      }),
    ).toBe(true);
  });
});

describe("shouldAckReactionForWhatsApp", () => {
  it("respects direct and group modes", () => {
    expect(
      shouldAckReactionForWhatsApp({
        directEnabled: false,
        emoji: "👀",
        groupActivated: false,
        groupMode: "mentions",
        isDirect: true,
        isGroup: false,
        wasMentioned: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReactionForWhatsApp({
        directEnabled: true,
        emoji: "👀",
        groupActivated: false,
        groupMode: "always",
        isDirect: false,
        isGroup: true,
        wasMentioned: false,
      }),
    ).toBe(true);

    expect(
      shouldAckReactionForWhatsApp({
        directEnabled: true,
        emoji: "👀",
        groupActivated: true,
        groupMode: "never",
        isDirect: false,
        isGroup: true,
        wasMentioned: true,
      }),
    ).toBe(false);
  });

  it("honors mentions or activation for group-mentions", () => {
    expect(
      shouldAckReactionForWhatsApp({
        directEnabled: true,
        emoji: "👀",
        groupActivated: true,
        groupMode: "mentions",
        isDirect: false,
        isGroup: true,
        wasMentioned: false,
      }),
    ).toBe(true);

    expect(
      shouldAckReactionForWhatsApp({
        directEnabled: true,
        emoji: "👀",
        groupActivated: false,
        groupMode: "mentions",
        isDirect: false,
        isGroup: true,
        wasMentioned: false,
      }),
    ).toBe(false);
  });
});

describe("removeAckReactionAfterReply", () => {
  it("removes only when ack succeeded", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    removeAckReactionAfterReply({
      ackReactionPromise: Promise.resolve(true),
      ackReactionValue: "👀",
      onError,
      remove,
      removeAfterReply: true,
    });
    await flushMicrotasks();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("skips removal when ack did not happen", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    removeAckReactionAfterReply({
      ackReactionPromise: Promise.resolve(false),
      ackReactionValue: "👀",
      remove,
      removeAfterReply: true,
    });
    await flushMicrotasks();
    expect(remove).not.toHaveBeenCalled();
  });
});
