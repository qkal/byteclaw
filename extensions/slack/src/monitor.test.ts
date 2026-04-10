import { describe, expect, it } from "vitest";
import { buildSlackSlashCommandMatcher } from "./monitor/commands.js";
import { isSlackChannelAllowedByPolicy } from "./monitor/policy.js";
import { resolveSlackThreadTs } from "./monitor/replies.js";

describe("slack groupPolicy gating", () => {
  it("allows when policy is open", () => {
    expect(
      isSlackChannelAllowedByPolicy({
        channelAllowed: false,
        channelAllowlistConfigured: false,
        groupPolicy: "open",
      }),
    ).toBe(true);
  });

  it("blocks when policy is disabled", () => {
    expect(
      isSlackChannelAllowedByPolicy({
        channelAllowed: true,
        channelAllowlistConfigured: true,
        groupPolicy: "disabled",
      }),
    ).toBe(false);
  });

  it("blocks allowlist when no channel allowlist configured", () => {
    expect(
      isSlackChannelAllowedByPolicy({
        channelAllowed: true,
        channelAllowlistConfigured: false,
        groupPolicy: "allowlist",
      }),
    ).toBe(false);
  });

  it("allows allowlist when channel is allowed", () => {
    expect(
      isSlackChannelAllowedByPolicy({
        channelAllowed: true,
        channelAllowlistConfigured: true,
        groupPolicy: "allowlist",
      }),
    ).toBe(true);
  });

  it("blocks allowlist when channel is not allowed", () => {
    expect(
      isSlackChannelAllowedByPolicy({
        channelAllowed: false,
        channelAllowlistConfigured: true,
        groupPolicy: "allowlist",
      }),
    ).toBe(false);
  });
});

describe("resolveSlackThreadTs", () => {
  const threadTs = "1234567890.123456";
  const messageTs = "9999999999.999999";

  it("stays in incoming threads for all replyToMode values", () => {
    for (const replyToMode of ["off", "first", "all", "batched"] as const) {
      for (const hasReplied of [false, true]) {
        expect(
          resolveSlackThreadTs({
            hasReplied,
            incomingThreadTs: threadTs,
            isThreadReply: true,
            messageTs,
            replyToMode,
          }),
        ).toBe(threadTs);
      }
    }
  });

  describe("replyToMode=off", () => {
    it("returns undefined when not in a thread", () => {
      expect(
        resolveSlackThreadTs({
          hasReplied: false,
          incomingThreadTs: undefined,
          messageTs,
          replyToMode: "off",
        }),
      ).toBeUndefined();
    });
  });

  describe("replyToMode=first", () => {
    it("returns messageTs for first reply when not in a thread", () => {
      expect(
        resolveSlackThreadTs({
          hasReplied: false,
          incomingThreadTs: undefined,
          messageTs,
          replyToMode: "first",
        }),
      ).toBe(messageTs);
    });

    it("returns undefined for subsequent replies when not in a thread (goes to main channel)", () => {
      expect(
        resolveSlackThreadTs({
          hasReplied: true,
          incomingThreadTs: undefined,
          messageTs,
          replyToMode: "first",
        }),
      ).toBeUndefined();
    });
  });

  describe("replyToMode=all", () => {
    it("returns messageTs when not in a thread (starts thread)", () => {
      expect(
        resolveSlackThreadTs({
          hasReplied: true,
          incomingThreadTs: undefined,
          messageTs,
          replyToMode: "all",
        }),
      ).toBe(messageTs);
    });
  });
});

describe("buildSlackSlashCommandMatcher", () => {
  it("matches with or without a leading slash", () => {
    const matcher = buildSlackSlashCommandMatcher("openclaw");

    expect(matcher.test("openclaw")).toBe(true);
    expect(matcher.test("/openclaw")).toBe(true);
  });

  it("does not match similar names", () => {
    const matcher = buildSlackSlashCommandMatcher("openclaw");

    expect(matcher.test("/openclaw-bot")).toBe(false);
    expect(matcher.test("openclaw-bot")).toBe(false);
  });
});
