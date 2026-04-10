import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";

type ReactionResolution = ReturnType<typeof resolveWhatsAppReactionLevel>;

describe("resolveWhatsAppReactionLevel", () => {
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

  it("defaults to minimal level when reactionLevel is not set", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: {} },
    };

    const result = resolveWhatsAppReactionLevel({ cfg });
    expectReactionFlags(result, {
      ackEnabled: false,
      agentReactionGuidance: "minimal",
      agentReactionsEnabled: true,
      level: "minimal",
    });
  });

  it("returns off level with no reactions enabled", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "off" } },
    };

    const result = resolveWhatsAppReactionLevel({ cfg });
    expectReactionFlags(result, {
      ackEnabled: false,
      agentReactionsEnabled: false,
      level: "off",
    });
  });

  it("returns ack level with only ackEnabled", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "ack" } },
    };

    const result = resolveWhatsAppReactionLevel({ cfg });
    expectReactionFlags(result, {
      ackEnabled: true,
      agentReactionsEnabled: false,
      level: "ack",
    });
  });

  it("returns minimal level with agent reactions enabled and minimal guidance", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "minimal" } },
    };

    const result = resolveWhatsAppReactionLevel({ cfg });
    expectReactionFlags(result, {
      ackEnabled: false,
      agentReactionGuidance: "minimal",
      agentReactionsEnabled: true,
      level: "minimal",
    });
  });

  it("returns extensive level with agent reactions enabled and extensive guidance", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "extensive" } },
    };

    const result = resolveWhatsAppReactionLevel({ cfg });
    expectReactionFlags(result, {
      ackEnabled: false,
      agentReactionGuidance: "extensive",
      agentReactionsEnabled: true,
      level: "extensive",
    });
  });

  it("resolves reaction level from a specific account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          accounts: {
            work: { reactionLevel: "extensive" },
          },
          reactionLevel: "minimal",
        },
      },
    };

    const result = resolveWhatsAppReactionLevel({ accountId: "work", cfg });
    expectReactionFlags(result, {
      ackEnabled: false,
      agentReactionGuidance: "extensive",
      agentReactionsEnabled: true,
      level: "extensive",
    });
  });
});
