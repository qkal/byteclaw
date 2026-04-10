import { describe, expect, it } from "vitest";
import { shouldPromoteRecentInviteRoom } from "./recent-invite.js";

describe("shouldPromoteRecentInviteRoom", () => {
  it("fails closed when room metadata could not be resolved", () => {
    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!room:example.org",
        roomInfo: {
          aliasesResolved: true,
          altAliases: [],
          nameResolved: false,
        },
      }),
    ).toBe(false);
  });

  it("rejects named or aliased rooms", () => {
    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!named:example.org",
        roomInfo: {
          aliasesResolved: true,
          altAliases: [],
          name: "Ops Room",
          nameResolved: true,
        },
      }),
    ).toBe(false);

    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!aliased:example.org",
        roomInfo: {
          aliasesResolved: true,
          altAliases: [],
          canonicalAlias: "#ops:example.org",
          nameResolved: true,
        },
      }),
    ).toBe(false);
  });

  it("rejects rooms explicitly configured by direct match", () => {
    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!room:example.org",
        roomInfo: {
          aliasesResolved: true,
          altAliases: [],
          nameResolved: true,
        },
        rooms: {
          "!room:example.org": {
            enabled: true,
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects rooms matched only by wildcard config", () => {
    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!room:example.org",
        roomInfo: {
          aliasesResolved: true,
          altAliases: [],
          nameResolved: true,
        },
        rooms: {
          "*": {
            enabled: false,
          },
        },
      }),
    ).toBe(false);
  });

  it("allows strict unnamed invite rooms without direct room config", () => {
    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!room:example.org",
        roomInfo: {
          aliasesResolved: true,
          altAliases: [],
          nameResolved: true,
        },
      }),
    ).toBe(true);
  });
});
