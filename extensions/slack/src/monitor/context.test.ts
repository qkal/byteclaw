import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it } from "vitest";
import { createSlackMonitorContext } from "./context.js";

function createTestContext() {
  return createSlackMonitorContext({
    accountId: "default",
    ackReactionScope: "group-mentions",
    allowFrom: [],
    allowNameMatching: false,
    apiAppId: "A_EXPECTED",
    app: { client: {} } as App,
    botToken: "xoxb-test",
    botUserId: "U_BOT",
    cfg: {
      channels: { slack: { enabled: true } },
      session: { dmScope: "main" },
    } as OpenClawConfig,
    defaultRequireMention: true,
    dmEnabled: true,
    dmPolicy: "open",
    groupDmChannels: [],
    groupDmEnabled: false,
    groupPolicy: "allowlist",
    historyLimit: 0,
    mainKey: "main",
    mediaMaxBytes: 20 * 1024 * 1024,
    reactionAllowlist: [],
    reactionMode: "off",
    removeAckAfterReply: false,
    replyToMode: "off",
    runtime: {} as RuntimeEnv,
    sessionScope: "per-sender",
    slashCommand: {
      enabled: true,
      ephemeral: true,
      name: "openclaw",
      sessionPrefix: "slack:slash",
    },
    teamId: "T_EXPECTED",
    textLimit: 4000,
    threadHistoryScope: "thread",
    threadInheritParent: false,
    threadRequireExplicitMention: false,
    typingReaction: "",
    useAccessGroups: true,
  });
}

describe("createSlackMonitorContext shouldDropMismatchedSlackEvent", () => {
  it("drops mismatched top-level app/team identifiers", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_WRONG",
        team_id: "T_EXPECTED",
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team_id: "T_WRONG",
      }),
    ).toBe(true);
  });

  it("drops mismatched nested team.id payloads used by interaction bodies", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_WRONG" },
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_EXPECTED" },
      }),
    ).toBe(false);
  });
});
