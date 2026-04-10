import { describe, expect, it } from "vitest";
import { findWildcardHintMatch, schemaHasChildren } from "./schema.shared.js";

describe("schema.shared", () => {
  it("prefers the most specific wildcard hint match", () => {
    const match = findWildcardHintMatch({
      path: "channels.telegram.token",
      splitPath: (value) => value.split("."),
      uiHints: {
        "channels.*.token": { label: "wildcard" },
        "channels.telegram.token": { label: "telegram" },
      },
    });

    expect(match).toEqual({
      hint: { label: "telegram" },
      path: "channels.telegram.token",
    });
  });

  it("treats branch schemas as having children", () => {
    expect(
      schemaHasChildren({
        oneOf: [{}, { properties: { token: {} } }],
      }),
    ).toBe(true);
  });
});
