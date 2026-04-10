import { describe, expect, it } from "vitest";
import {
  formatGoogleOauthApiKey,
  parseGoogleOauthApiKey,
  parseGoogleUsageToken,
} from "./oauth-token-shared.js";

describe("google oauth token helpers", () => {
  it("formats oauth credentials with project-aware payloads", () => {
    expect(
      formatGoogleOauthApiKey({
        access: "token-123",
        projectId: "project-abc",
        type: "oauth",
      }),
    ).toBe(JSON.stringify({ projectId: "project-abc", token: "token-123" }));
  });

  it("returns an empty string for non-oauth credentials", () => {
    expect(formatGoogleOauthApiKey({ access: "token-123", type: "token" })).toBe("");
  });

  it("parses project-aware oauth payloads for usage auth", () => {
    expect(parseGoogleUsageToken(JSON.stringify({ token: "usage-token" }))).toBe("usage-token");
  });

  it("parses structured oauth payload fields", () => {
    expect(
      parseGoogleOauthApiKey(JSON.stringify({ projectId: "proj-1", token: "usage-token" })),
    ).toEqual({
      projectId: "proj-1",
      token: "usage-token",
    });
  });

  it("falls back to the raw token when the payload is not JSON", () => {
    expect(parseGoogleUsageToken("raw-token")).toBe("raw-token");
  });
});
