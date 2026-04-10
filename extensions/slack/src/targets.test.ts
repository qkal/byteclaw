import { describe, expect, it } from "vitest";
import {
  normalizeSlackMessagingTarget,
  parseSlackTarget,
  resolveSlackChannelId,
} from "./targets.js";

describe("parseSlackTarget", () => {
  it("parses user mentions and prefixes", () => {
    const cases = [
      { id: "U123", input: "<@U123>", normalized: "user:u123" },
      { id: "U456", input: "user:U456", normalized: "user:u456" },
      { id: "U789", input: "slack:U789", normalized: "user:u789" },
    ] as const;
    for (const testCase of cases) {
      expect(parseSlackTarget(testCase.input), testCase.input).toMatchObject({
        id: testCase.id,
        kind: "user",
        normalized: testCase.normalized,
      });
    }
  });

  it("parses channel targets", () => {
    const cases = [
      { id: "C123", input: "channel:C123", normalized: "channel:c123" },
      { id: "C999", input: "#C999", normalized: "channel:c999" },
    ] as const;
    for (const testCase of cases) {
      expect(parseSlackTarget(testCase.input), testCase.input).toMatchObject({
        id: testCase.id,
        kind: "channel",
        normalized: testCase.normalized,
      });
    }
  });

  it("rejects invalid @ and # targets", () => {
    const cases = [
      { expectedMessage: /Slack DMs require a user id/, input: "@bob-1" },
      { expectedMessage: /Slack channels require a channel id/, input: "#general-1" },
    ] as const;
    for (const testCase of cases) {
      expect(() => parseSlackTarget(testCase.input), testCase.input).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});

describe("resolveSlackChannelId", () => {
  it("strips channel: prefix and accepts raw ids", () => {
    expect(resolveSlackChannelId("channel:C123")).toBe("C123");
    expect(resolveSlackChannelId("C123")).toBe("C123");
  });

  it("rejects user targets", () => {
    expect(() => resolveSlackChannelId("user:U123")).toThrow(/channel id is required/i);
  });
});

describe("normalizeSlackMessagingTarget", () => {
  it("defaults raw ids to channels", () => {
    expect(normalizeSlackMessagingTarget("C123")).toBe("channel:c123");
  });
});
