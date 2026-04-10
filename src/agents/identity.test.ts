import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAckReaction } from "./identity.js";

describe("resolveAckReaction", () => {
  it("prefers account-level overrides", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "✅" } }] },
      channels: {
        slack: {
          accounts: {
            acct1: { ackReaction: " party_parrot " },
          },
          ackReaction: "eyes",
        },
      },
      messages: { ackReaction: "👀" },
    };

    expect(resolveAckReaction(cfg, "main", { accountId: "acct1", channel: "slack" })).toBe(
      "party_parrot",
    );
  });

  it("falls back to channel-level overrides", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "✅" } }] },
      channels: {
        slack: {
          accounts: {
            acct1: { ackReaction: "party_parrot" },
          },
          ackReaction: "eyes",
        },
      },
      messages: { ackReaction: "👀" },
    };

    expect(resolveAckReaction(cfg, "main", { accountId: "missing", channel: "slack" })).toBe(
      "eyes",
    );
  });

  it("uses the global ackReaction when channel overrides are missing", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "😺" } }] },
      messages: { ackReaction: "✅" },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "discord" })).toBe("✅");
  });

  it("falls back to the agent identity emoji when global config is unset", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "discord" })).toBe("🔥");
  });

  it("returns the default emoji when no config is present", () => {
    const cfg: OpenClawConfig = {};

    expect(resolveAckReaction(cfg, "main")).toBe("👀");
  });

  it("allows empty strings to disable reactions", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          ackReaction: "",
        },
      },
      messages: { ackReaction: "👀" },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "telegram" })).toBe("");
  });
});
