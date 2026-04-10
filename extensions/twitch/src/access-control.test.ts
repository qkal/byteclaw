import { describe, expect, it } from "vitest";
import { checkTwitchAccessControl, extractMentions } from "./access-control.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

describe("checkTwitchAccessControl", () => {
  const mockAccount: TwitchAccountConfig = {
    accessToken: "test",
    channel: "testchannel",
    clientId: "test-client-id",
    username: "testbot",
  };

  const mockMessage: TwitchChatMessage = {
    channel: "testchannel",
    message: "hello bot",
    userId: "123456",
    username: "testuser",
  };

  function runAccessCheck(params: {
    account?: Partial<TwitchAccountConfig>;
    message?: Partial<TwitchChatMessage>;
  }) {
    return checkTwitchAccessControl({
      account: {
        ...mockAccount,
        ...params.account,
      },
      botUsername: "testbot",
      message: {
        ...mockMessage,
        ...params.message,
      },
    });
  }

  function expectSingleRoleAllowed(params: {
    role: NonNullable<TwitchAccountConfig["allowedRoles"]>[number];
    message: Partial<TwitchChatMessage>;
  }) {
    const result = runAccessCheck({
      account: { allowedRoles: [params.role] },
      message: {
        message: "@testbot hello",
        ...params.message,
      },
    });
    expect(result.allowed).toBe(true);
    return result;
  }

  function expectAllowedAccessCheck(params: {
    account?: Partial<TwitchAccountConfig>;
    message?: Partial<TwitchChatMessage>;
  }) {
    const result = runAccessCheck({
      account: params.account,
      message: {
        message: "@testbot hello",
        ...params.message,
      },
    });
    expect(result.allowed).toBe(true);
    return result;
  }

  function expectAllowFromBlocked(params: {
    allowFrom: string[];
    allowedRoles?: NonNullable<TwitchAccountConfig["allowedRoles"]>;
    message?: Partial<TwitchChatMessage>;
    reason: string;
  }) {
    const result = runAccessCheck({
      account: {
        allowFrom: params.allowFrom,
        allowedRoles: params.allowedRoles,
      },
      message: {
        message: "@testbot hello",
        ...params.message,
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(params.reason);
  }

  describe("when no restrictions are configured", () => {
    it("allows messages that mention the bot (default requireMention)", () => {
      const result = runAccessCheck({
        message: {
          message: "@testbot hello",
        },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("requireMention default", () => {
    it("defaults to true when undefined", () => {
      const result = runAccessCheck({
        message: {
          message: "hello bot",
        },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("allows mention when requireMention is undefined", () => {
      const result = runAccessCheck({
        message: {
          message: "@testbot hello",
        },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("requireMention", () => {
    it("allows messages that mention the bot", () => {
      const result = runAccessCheck({
        account: { requireMention: true },
        message: { message: "@testbot hello" },
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks messages that don't mention the bot", () => {
      const result = runAccessCheck({
        account: { requireMention: true },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("is case-insensitive for bot username", () => {
      const result = runAccessCheck({
        account: { requireMention: true },
        message: { message: "@TestBot hello" },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("allowFrom allowlist", () => {
    it("allows users in the allowlist", () => {
      const result = expectAllowedAccessCheck({
        account: {
          allowFrom: ["123456", "789012"],
        },
      });
      expect(result.matchKey).toBe("123456");
      expect(result.matchSource).toBe("allowlist");
    });

    it("blocks users not in allowlist when allowFrom is set", () => {
      expectAllowFromBlocked({
        allowFrom: ["789012"],
        reason: "allowFrom",
      });
    });

    it("blocks everyone when allowFrom is explicitly empty", () => {
      expectAllowFromBlocked({
        allowFrom: [],
        reason: "allowFrom",
      });
    });

    it("blocks messages without userId", () => {
      expectAllowFromBlocked({
        allowFrom: ["123456"],
        message: { userId: undefined },
        reason: "user ID not available",
      });
    });

    it("bypasses role checks when user is in allowlist", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["123456"],
        allowedRoles: ["owner"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        isOwner: false,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        account,
        botUsername: "testbot",
        message,
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks user with role when not in allowlist", () => {
      expectAllowFromBlocked({
        allowFrom: ["789012"],
        allowedRoles: ["moderator"],
        message: { isMod: true, userId: "123456" },
        reason: "allowFrom",
      });
    });

    it("blocks user not in allowlist even when roles configured", () => {
      expectAllowFromBlocked({
        allowFrom: ["789012"],
        allowedRoles: ["moderator"],
        message: { isMod: false, userId: "123456" },
        reason: "allowFrom",
      });
    });
  });

  describe("allowedRoles", () => {
    it("allows users with matching role", () => {
      const result = expectSingleRoleAllowed({
        message: { isMod: true },
        role: "moderator",
      });
      expect(result.matchSource).toBe("role");
    });

    it("allows users with any of multiple roles", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["moderator", "vip", "subscriber"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        isMod: false,
        isSub: false,
        isVip: true,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        account,
        botUsername: "testbot",
        message,
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks users without matching role", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["moderator"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        isMod: false,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        account,
        botUsername: "testbot",
        message,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not have any of the required roles");
    });

    it("allows all users when role is 'all'", () => {
      const result = expectAllowedAccessCheck({
        account: {
          allowedRoles: ["all"],
        },
      });
      expect(result.matchKey).toBe("all");
    });

    it("handles moderator role", () => {
      expectSingleRoleAllowed({
        message: { isMod: true },
        role: "moderator",
      });
    });

    it("handles subscriber role", () => {
      expectSingleRoleAllowed({
        message: { isSub: true },
        role: "subscriber",
      });
    });

    it("handles owner role", () => {
      expectSingleRoleAllowed({
        message: { isOwner: true },
        role: "owner",
      });
    });

    it("handles vip role", () => {
      expectSingleRoleAllowed({
        message: { isVip: true },
        role: "vip",
      });
    });
  });

  describe("combined restrictions", () => {
    it("checks requireMention before allowlist", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["123456"],
        requireMention: true,
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "hello", // No mention
      };

      const result = checkTwitchAccessControl({
        account,
        botUsername: "testbot",
        message,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("checks allowlist before allowedRoles", () => {
      const result = runAccessCheck({
        account: {
          allowFrom: ["123456"],
          allowedRoles: ["owner"],
        },
        message: {
          isOwner: false,
          message: "@testbot hello",
        },
      });
      expect(result.allowed).toBe(true);
      expect(result.matchSource).toBe("allowlist");
    });
  });
});

describe("extractMentions", () => {
  it("extracts single mention", () => {
    const mentions = extractMentions("hello @testbot");
    expect(mentions).toEqual(["testbot"]);
  });

  it("extracts multiple mentions", () => {
    const mentions = extractMentions("hello @testbot and @otheruser");
    expect(mentions).toEqual(["testbot", "otheruser"]);
  });

  it("returns empty array when no mentions", () => {
    const mentions = extractMentions("hello everyone");
    expect(mentions).toEqual([]);
  });

  it("handles mentions at start of message", () => {
    const mentions = extractMentions("@testbot hello");
    expect(mentions).toEqual(["testbot"]);
  });

  it("handles mentions at end of message", () => {
    const mentions = extractMentions("hello @testbot");
    expect(mentions).toEqual(["testbot"]);
  });

  it("converts mentions to lowercase", () => {
    const mentions = extractMentions("hello @TestBot");
    expect(mentions).toEqual(["testbot"]);
  });

  it("extracts alphanumeric usernames", () => {
    const mentions = extractMentions("hello @user123");
    expect(mentions).toEqual(["user123"]);
  });

  it("handles underscores in usernames", () => {
    const mentions = extractMentions("hello @test_user");
    expect(mentions).toEqual(["test_user"]);
  });

  it("handles empty string", () => {
    const mentions = extractMentions("");
    expect(mentions).toEqual([]);
  });
});
