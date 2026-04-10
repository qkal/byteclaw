import { describe, expect, it } from "vitest";
import { resolveMatrixAckReactionConfig } from "./ack-config.js";

describe("resolveMatrixAckReactionConfig", () => {
  it("prefers account-level ack reaction and scope overrides", () => {
    expect(
      resolveMatrixAckReactionConfig({
        accountId: "ops",
        agentId: "ops-agent",
        cfg: {
          channels: {
            matrix: {
              accounts: {
                ops: {
                  ackReaction: "🟢",
                  ackReactionScope: "direct",
                },
              },
              ackReaction: "✅",
              ackReactionScope: "group-all",
            },
          },
          messages: {
            ackReaction: "👀",
            ackReactionScope: "all",
          },
        },
      }),
    ).toEqual({
      ackReaction: "🟢",
      ackReactionScope: "direct",
    });
  });

  it("falls back to channel then global settings", () => {
    expect(
      resolveMatrixAckReactionConfig({
        accountId: "missing",
        agentId: "ops-agent",
        cfg: {
          channels: {
            matrix: {
              ackReaction: "✅",
            },
          },
          messages: {
            ackReaction: "👀",
            ackReactionScope: "all",
          },
        },
      }),
    ).toEqual({
      ackReaction: "✅",
      ackReactionScope: "all",
    });
  });
});
