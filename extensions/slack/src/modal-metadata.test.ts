import { describe, expect, it } from "vitest";
import {
  encodeSlackModalPrivateMetadata,
  parseSlackModalPrivateMetadata,
} from "./modal-metadata.js";

describe("parseSlackModalPrivateMetadata", () => {
  it("returns empty object for missing or invalid values", () => {
    expect(parseSlackModalPrivateMetadata(undefined)).toEqual({});
    expect(parseSlackModalPrivateMetadata("")).toEqual({});
    expect(parseSlackModalPrivateMetadata("{bad-json")).toEqual({});
  });

  it("parses known metadata fields", () => {
    expect(
      parseSlackModalPrivateMetadata(
        JSON.stringify({
          channelId: "D123",
          channelType: "im",
          ignored: "x",
          sessionKey: "agent:main:slack:channel:C1",
          userId: "U123",
        }),
      ),
    ).toEqual({
      channelId: "D123",
      channelType: "im",
      sessionKey: "agent:main:slack:channel:C1",
      userId: "U123",
    });
  });
});

describe("encodeSlackModalPrivateMetadata", () => {
  it("encodes only known non-empty fields", () => {
    expect(
      JSON.parse(
        encodeSlackModalPrivateMetadata({
          channelId: "",
          channelType: "im",
          sessionKey: "agent:main:slack:channel:C1",
          userId: "U123",
        }),
      ),
    ).toEqual({
      channelType: "im",
      sessionKey: "agent:main:slack:channel:C1",
      userId: "U123",
    });
  });

  it("throws when encoded payload exceeds Slack metadata limit", () => {
    expect(() =>
      encodeSlackModalPrivateMetadata({
        sessionKey: `agent:main:${"x".repeat(4000)}`,
      }),
    ).toThrow(/cannot exceed 3000 chars/i);
  });
});
