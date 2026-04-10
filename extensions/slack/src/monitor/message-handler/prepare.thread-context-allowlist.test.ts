import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";

const [{ prepareSlackMessage }, helpers] = await Promise.all([
  import("./prepare.js"),
  import("./prepare.test-helpers.js"),
]);
const { createInboundSlackTestContext, createSlackTestAccount } = helpers;
let fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-room-thread-context-"));
let caseId = 0;

function makeTmpStorePath() {
  if (!fixtureRoot) {
    throw new Error("fixtureRoot missing");
  }
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  fs.mkdirSync(dir);
  return path.join(dir, "sessions.json");
}

interface ThreadContextCaseParams {
  channel: string;
  channelType: SlackMessageEvent["channel_type"];
  user: string;
  userName: string;
  starterText: string;
  followUpText: string;
  startTs: string;
  replyTs: string;
  followUpTs: string;
  currentTs: string;
  channelsConfig?: Parameters<typeof createInboundSlackTestContext>[0]["channelsConfig"];
  resolveChannelName?: (channelId: string) => Promise<{
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  }>;
}

async function prepareThreadContextCase(params: ThreadContextCaseParams) {
  const replies = vi
    .fn()
    .mockResolvedValueOnce({
      messages: [{ text: params.starterText, ts: params.startTs, user: params.user }],
    })
    .mockResolvedValueOnce({
      messages: [
        { text: params.starterText, ts: params.startTs, user: params.user },
        { bot_id: "B1", text: "assistant reply", ts: params.replyTs },
        { text: params.followUpText, ts: params.followUpTs, user: params.user },
        { text: "current message", ts: params.currentTs, user: params.user },
      ],
      response_metadata: { next_cursor: "" },
    });
  const ctx = createInboundSlackTestContext({
    appClient: { conversations: { replies } } as unknown as App["client"],
    cfg: {
      channels: {
        slack: {
          contextVisibility: "allowlist",
          enabled: true,
          groupPolicy: "open",
          replyToMode: "all",
        },
      },
      session: { store: makeTmpStorePath() },
    } as OpenClawConfig,
    channelsConfig: params.channelsConfig,
    defaultRequireMention: false,
    replyToMode: "all",
  });
  ctx.allowFrom = ["u-owner"];
  ctx.resolveUserName = async (id: string) => ({
    name: id === params.user ? params.userName : "Owner",
  });
  if (params.resolveChannelName) {
    ctx.resolveChannelName = params.resolveChannelName;
  }

  const prepared = await prepareSlackMessage({
    account: createSlackTestAccount({
      replyToMode: "all",
      thread: { initialHistoryLimit: 20 },
    }),
    ctx,
    message: {
      channel: params.channel,
      channel_type: params.channelType,
      text: "current message",
      thread_ts: params.startTs,
      ts: params.currentTs,
      user: params.user,
    } as SlackMessageEvent,
    opts: { source: "message" },
  });

  return { prepared, replies };
}

describe("prepareSlackMessage thread context allowlists", () => {
  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
      fixtureRoot = "";
    }
  });

  it("uses room users allowlist for thread context filtering", async () => {
    const { prepared, replies } = await prepareThreadContextCase({
      channel: "C123",
      channelType: "channel",
      channelsConfig: {
        C123: {
          requireMention: false,
          users: ["U1"],
        },
      },
      currentTs: "101.000",
      followUpText: "allowed follow-up",
      followUpTs: "100.800",
      replyTs: "100.500",
      resolveChannelName: async () => ({ name: "general", type: "channel" }),
      startTs: "100.000",
      starterText: "starter from room user",
      user: "U1",
      userName: "Alice",
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from room user");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from room user");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("allowed follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not apply the owner allowlist to open-room thread context", async () => {
    const { prepared, replies } = await prepareThreadContextCase({
      channel: "C124",
      channelType: "channel",
      channelsConfig: {
        C124: {
          requireMention: false,
        },
      },
      currentTs: "201.000",
      followUpText: "open-room follow-up",
      followUpTs: "200.800",
      replyTs: "200.500",
      resolveChannelName: async () => ({ name: "general", type: "channel" }),
      startTs: "200.000",
      starterText: "starter from open room",
      user: "U2",
      userName: "Bob",
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from open room");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from open room");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("open-room follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not apply the owner allowlist to open DMs when dmPolicy is open", async () => {
    const { prepared, replies } = await prepareThreadContextCase({
      channel: "D300",
      channelType: "im",
      currentTs: "301.000",
      followUpText: "dm follow-up",
      followUpTs: "300.800",
      replyTs: "300.500",
      startTs: "300.000",
      starterText: "starter from open dm",
      user: "U3",
      userName: "Dana",
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from open dm");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from open dm");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("dm follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not apply the owner allowlist to MPIM thread context", async () => {
    const { prepared, replies } = await prepareThreadContextCase({
      channel: "G400",
      channelType: "mpim",
      currentTs: "401.000",
      followUpText: "mpim follow-up",
      followUpTs: "400.800",
      replyTs: "400.500",
      startTs: "400.000",
      starterText: "starter from mpim",
      user: "U4",
      userName: "Evan",
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from mpim");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from mpim");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("mpim follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });
});
