import { describe, expect, it } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";
import {
  isMSTeamsGroupAllowed,
  resolveMSTeamsReplyPolicy,
  resolveMSTeamsRouteConfig,
} from "./policy.js";

function resolveNamedTeamRouteConfig(allowNameMatching = false) {
  const cfg: MSTeamsConfig = {
    teams: {
      "My Team": {
        channels: {
          "General Chat": { requireMention: false },
        },
        requireMention: true,
      },
    },
  };

  return resolveMSTeamsRouteConfig({
    allowNameMatching,
    cfg,
    channelName: "General Chat",
    conversationId: "ignored",
    teamName: "My Team",
  });
}

describe("msteams policy", () => {
  describe("resolveMSTeamsRouteConfig", () => {
    it("returns team and channel config when present", () => {
      const cfg: MSTeamsConfig = {
        teams: {
          team123: {
            channels: {
              chan456: { requireMention: true },
            },
            requireMention: false,
          },
        },
      };

      const res = resolveMSTeamsRouteConfig({
        cfg,
        conversationId: "chan456",
        teamId: "team123",
      });

      if (!res.teamConfig || !res.channelConfig) {
        throw new Error("expected matched team and channel config");
      }
      expect(res.teamConfig.requireMention).toBe(false);
      expect(res.channelConfig.requireMention).toBe(true);
      expect(res.allowlistConfigured).toBe(true);
      expect(res.allowed).toBe(true);
      expect(res.channelMatchKey).toBe("chan456");
      expect(res.channelMatchSource).toBe("direct");
    });

    it("returns undefined configs when teamId is missing", () => {
      const cfg: MSTeamsConfig = {
        teams: { team123: { requireMention: false } },
      };

      const res = resolveMSTeamsRouteConfig({
        cfg,
        conversationId: "chan",
        teamId: undefined,
      });
      expect(res.teamConfig).toBeUndefined();
      expect(res.channelConfig).toBeUndefined();
      expect(res.allowlistConfigured).toBe(true);
      expect(res.allowed).toBe(false);
    });

    it("blocks team and channel name matches by default", () => {
      const res = resolveNamedTeamRouteConfig();

      expect(res.teamConfig).toBeUndefined();
      expect(res.channelConfig).toBeUndefined();
      expect(res.allowed).toBe(false);
    });

    it("matches team and channel by name when dangerous name matching is enabled", () => {
      const res = resolveNamedTeamRouteConfig(true);

      if (!res.teamConfig || !res.channelConfig) {
        throw new Error("expected matched named team and channel config");
      }
      expect(res.teamConfig.requireMention).toBe(true);
      expect(res.channelConfig.requireMention).toBe(false);
      expect(res.allowed).toBe(true);
    });
  });

  describe("resolveMSTeamsReplyPolicy", () => {
    it("forces thread replies for direct messages", () => {
      const policy = resolveMSTeamsReplyPolicy({
        globalConfig: { replyStyle: "top-level", requireMention: false },
        isDirectMessage: true,
      });
      expect(policy).toEqual({ replyStyle: "thread", requireMention: false });
    });

    it("defaults to requireMention=true and replyStyle=thread", () => {
      const policy = resolveMSTeamsReplyPolicy({
        globalConfig: {},
        isDirectMessage: false,
      });
      expect(policy).toEqual({ replyStyle: "thread", requireMention: true });
    });

    it("defaults replyStyle to top-level when requireMention=false", () => {
      const policy = resolveMSTeamsReplyPolicy({
        globalConfig: { requireMention: false },
        isDirectMessage: false,
      });
      expect(policy).toEqual({
        replyStyle: "top-level",
        requireMention: false,
      });
    });

    it("prefers channel overrides over team and global defaults", () => {
      const policy = resolveMSTeamsReplyPolicy({
        channelConfig: { requireMention: false },
        globalConfig: { requireMention: true },
        isDirectMessage: false,
        teamConfig: { requireMention: true },
      });

      // RequireMention from channel -> false, and replyStyle defaults from requireMention -> top-level
      expect(policy).toEqual({
        replyStyle: "top-level",
        requireMention: false,
      });
    });

    it("inherits team mention settings when channel config is missing", () => {
      const policy = resolveMSTeamsReplyPolicy({
        globalConfig: { requireMention: true },
        isDirectMessage: false,
        teamConfig: { requireMention: false },
      });
      expect(policy).toEqual({
        replyStyle: "top-level",
        requireMention: false,
      });
    });

    it("uses explicit replyStyle even when requireMention defaults would differ", () => {
      const policy = resolveMSTeamsReplyPolicy({
        globalConfig: { replyStyle: "thread", requireMention: false },
        isDirectMessage: false,
      });
      expect(policy).toEqual({ replyStyle: "thread", requireMention: false });
    });
  });

  describe("isMSTeamsGroupAllowed", () => {
    it("allows when policy is open", () => {
      expect(
        isMSTeamsGroupAllowed({
          allowFrom: [],
          groupPolicy: "open",
          senderId: "user-id",
          senderName: "User",
        }),
      ).toBe(true);
    });

    it("blocks when policy is disabled", () => {
      expect(
        isMSTeamsGroupAllowed({
          allowFrom: ["user-id"],
          groupPolicy: "disabled",
          senderId: "user-id",
          senderName: "User",
        }),
      ).toBe(false);
    });

    it("blocks allowlist when empty", () => {
      expect(
        isMSTeamsGroupAllowed({
          allowFrom: [],
          groupPolicy: "allowlist",
          senderId: "user-id",
          senderName: "User",
        }),
      ).toBe(false);
    });

    it("allows allowlist when sender matches", () => {
      expect(
        isMSTeamsGroupAllowed({
          allowFrom: ["User-Id"],
          groupPolicy: "allowlist",
          senderId: "user-id",
          senderName: "User",
        }),
      ).toBe(true);
    });

    it("blocks sender-name allowlist matches by default", () => {
      expect(
        isMSTeamsGroupAllowed({
          allowFrom: ["user"],
          groupPolicy: "allowlist",
          senderId: "other",
          senderName: "User",
        }),
      ).toBe(false);
    });

    it("allows sender-name allowlist matches when explicitly enabled", () => {
      expect(
        isMSTeamsGroupAllowed({
          allowFrom: ["user"],
          allowNameMatching: true,
          groupPolicy: "allowlist",
          senderId: "other",
          senderName: "User",
        }),
      ).toBe(true);
    });

    it("allows allowlist wildcard", () => {
      expect(
        isMSTeamsGroupAllowed({
          allowFrom: ["*"],
          groupPolicy: "allowlist",
          senderId: "other",
          senderName: "User",
        }),
      ).toBe(true);
    });
  });
});
