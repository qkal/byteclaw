import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTelegramReactionLevel } from "./reaction-level.js";

type ReactionResolution = ReturnType<typeof resolveTelegramReactionLevel>;

describe("resolveTelegramReactionLevel", () => {
  const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;

  const expectReactionFlags = (
    result: ReactionResolution,
    expected: {
      level: "off" | "ack" | "minimal" | "extensive";
      ackEnabled: boolean;
      agentReactionsEnabled: boolean;
      agentReactionGuidance?: "minimal" | "extensive";
    },
  ) => {
    expect(result.level).toBe(expected.level);
    expect(result.ackEnabled).toBe(expected.ackEnabled);
    expect(result.agentReactionsEnabled).toBe(expected.agentReactionsEnabled);
    expect(result.agentReactionGuidance).toBe(expected.agentReactionGuidance);
  };

  const expectMinimalFlags = (result: ReactionResolution) => {
    expectReactionFlags(result, {
      ackEnabled: false,
      agentReactionGuidance: "minimal",
      agentReactionsEnabled: true,
      level: "minimal",
    });
  };

  const expectExtensiveFlags = (result: ReactionResolution) => {
    expectReactionFlags(result, {
      ackEnabled: false,
      agentReactionGuidance: "extensive",
      agentReactionsEnabled: true,
      level: "extensive",
    });
  };

  beforeAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
  });

  afterAll(() => {
    if (prevTelegramToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
    }
  });

  it("defaults to minimal level when reactionLevel is not set", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: {} },
    };

    const result = resolveTelegramReactionLevel({ cfg });
    expectMinimalFlags(result);
  });

  it("returns off level with no reactions enabled", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { reactionLevel: "off" } },
    };

    const result = resolveTelegramReactionLevel({ cfg });
    expectReactionFlags(result, {
      ackEnabled: false,
      agentReactionsEnabled: false,
      level: "off",
    });
  });

  it("returns ack level with only ackEnabled", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { reactionLevel: "ack" } },
    };

    const result = resolveTelegramReactionLevel({ cfg });
    expectReactionFlags(result, {
      ackEnabled: true,
      agentReactionsEnabled: false,
      level: "ack",
    });
  });

  it("returns minimal level with agent reactions enabled and minimal guidance", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { reactionLevel: "minimal" } },
    };

    const result = resolveTelegramReactionLevel({ cfg });
    expectMinimalFlags(result);
  });

  it("returns extensive level with agent reactions enabled and extensive guidance", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { reactionLevel: "extensive" } },
    };

    const result = resolveTelegramReactionLevel({ cfg });
    expectExtensiveFlags(result);
  });

  it("resolves reaction level from a specific account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            work: { botToken: "tok-work", reactionLevel: "extensive" },
          },
          reactionLevel: "ack",
        },
      },
    };

    const result = resolveTelegramReactionLevel({ accountId: "work", cfg });
    expectExtensiveFlags(result);
  });

  it("falls back to global level when account has no reactionLevel", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            work: { botToken: "tok-work" },
          },
          reactionLevel: "minimal",
        },
      },
    };

    const result = resolveTelegramReactionLevel({ accountId: "work", cfg });
    expectMinimalFlags(result);
  });
});
