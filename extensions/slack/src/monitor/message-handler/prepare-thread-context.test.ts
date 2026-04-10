import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "@slack/bolt";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackThreadContextData } from "./prepare-thread-context.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

describe("resolveSlackThreadContextData", () => {
  let fixtureRoot = "";
  let caseId = 0;

  function makeTmpStorePath() {
    if (!fixtureRoot) {
      throw new Error("fixtureRoot missing");
    }
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    fs.mkdirSync(dir);
    return { dir, storePath: path.join(dir, "sessions.json") };
  }

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-thread-context-"));
  });

  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
      fixtureRoot = "";
    }
  });

  function createThreadContext(params: { replies: unknown }) {
    return createInboundSlackTestContext({
      appClient: { conversations: { replies: params.replies } } as App["client"],
      cfg: {
        channels: { slack: { enabled: true, groupPolicy: "open", replyToMode: "all" } },
      } as OpenClawConfig,
      defaultRequireMention: false,
      replyToMode: "all",
    });
  }

  function createThreadMessage(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return {
      channel: "C123",
      channel_type: "channel",
      text: "current message",
      thread_ts: "100.000",
      ts: "101.000",
      user: "U1",
      ...overrides,
    } as SlackMessageEvent;
  }

  it("omits non-allowlisted starter text and thread history messages", async () => {
    const { storePath } = makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { text: "starter secret", ts: "100.000", user: "U2" },
        { bot_id: "B1", text: "assistant reply", ts: "100.500" },
        { text: "blocked follow-up", ts: "100.700", user: "U2" },
        { text: "allowed follow-up", ts: "100.800", user: "U1" },
        { text: "current message", ts: "101.000", user: "U1" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U1" ? "Alice" : "Mallory",
    });

    const result = await resolveSlackThreadContextData({
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
      allowFromLower: ["u1"],
      allowNameMatching: false,
      contextVisibilityMode: "allowlist",
      ctx,
      effectiveDirectMedia: null,
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      isThreadReply: true,
      message: createThreadMessage(),
      roomLabel: "#general",
      sessionKey: "thread-session",
      storePath,
      threadStarter: {
        text: "starter secret",
        ts: "100.000",
        userId: "U2",
      },
      threadTs: "100.000",
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general");
    expect(result.threadHistoryBody).toContain("assistant reply");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("starter secret");
    expect(result.threadHistoryBody).not.toContain("blocked follow-up");
    expect(result.threadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("keeps starter text and history when allowNameMatching authorizes the sender", async () => {
    const { storePath } = makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { text: "starter from Alice", ts: "100.000", user: "U1" },
        { text: "blocked follow-up", ts: "100.700", user: "U2" },
        { text: "current message", ts: "101.000", user: "U1" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U1" ? "Alice" : "Mallory",
    });

    const result = await resolveSlackThreadContextData({
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
      allowFromLower: ["alice"],
      allowNameMatching: true,
      contextVisibilityMode: "allowlist",
      ctx,
      effectiveDirectMedia: null,
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      isThreadReply: true,
      message: createThreadMessage(),
      roomLabel: "#general",
      sessionKey: "thread-session",
      storePath,
      threadStarter: {
        text: "starter from Alice",
        ts: "100.000",
        userId: "U1",
      },
      threadTs: "100.000",
    });

    expect(result.threadStarterBody).toBe("starter from Alice");
    expect(result.threadLabel).toContain("starter from Alice");
    expect(result.threadHistoryBody).toContain("starter from Alice");
    expect(result.threadHistoryBody).not.toContain("blocked follow-up");
  });
});
