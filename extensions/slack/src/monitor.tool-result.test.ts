import type { vi } from "vitest";
import { beforeEach, describe, expect, it } from "vitest";
import { expectPairingReplyText } from "../../../test/helpers/pairing-reply.js";
import {
  defaultSlackTestConfig,
  flush,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackHandlers,
  getSlackTestState,
  resetSlackTestState,
  runSlackMessageOnce,
  startSlackMonitor,
  stopSlackMonitor,
} from "./monitor.test-helpers.js";

const [
  { resetInboundDedupe },
  { HISTORY_CONTEXT_MARKER },
  { CURRENT_MESSAGE_MARKER },
  { monitorSlackProvider },
] = await Promise.all([
  import("openclaw/plugin-sdk/reply-runtime"),
  import("../../../src/auto-reply/reply/history.js"),
  import("../../../src/auto-reply/reply/mentions.js"),
  import("./monitor/provider.js"),
]);

const slackTestState = getSlackTestState();
const { sendMock, replyMock, reactMock, upsertPairingRequestMock } = slackTestState;

beforeEach(() => {
  resetInboundDedupe();
  resetSlackTestState(defaultSlackTestConfig());
});

describe("monitorSlackProvider tool results", () => {
  interface SlackMessageEvent {
    type: "message";
    user: string;
    text: string;
    ts: string;
    channel: string;
    channel_type: "im" | "channel";
    thread_ts?: string;
    parent_user_id?: string;
  }

  const baseSlackMessageEvent = Object.freeze({
    channel: "C1",
    channel_type: "im",
    text: "hello",
    ts: "123",
    type: "message",
    user: "U1",
  }) as SlackMessageEvent;

  function makeSlackMessageEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return { ...baseSlackMessageEvent, ...overrides };
  }

  function setDirectMessageReplyMode(replyToMode: "off" | "all" | "first") {
    slackTestState.config = {
      channels: {
        slack: {
          dm: { allowFrom: ["*"], enabled: true, policy: "open" },
          replyToMode,
        },
      },
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
        responsePrefix: "PFX",
      },
    };
  }

  function firstReplyCtx(): { WasMentioned?: boolean } {
    return (replyMock.mock.calls[0]?.[0] ?? {}) as { WasMentioned?: boolean };
  }

  function setRequireMentionChannelConfig(mentionPatterns?: string[]) {
    slackTestState.config = {
      ...(mentionPatterns
        ? {
            messages: {
              groupChat: { mentionPatterns },
              responsePrefix: "PFX",
            },
          }
        : {}),
      channels: {
        slack: {
          channels: { C1: { allow: true, requireMention: true } },
          dm: { allowFrom: ["*"], enabled: true, policy: "open" },
        },
      },
    };
  }

  async function runDirectMessageEvent(ts: string, extraEvent: Record<string, unknown> = {}) {
    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({ ts, ...extraEvent }),
    });
  }

  async function runChannelThreadReplyEvent() {
    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        channel_type: "channel",
        text: "thread reply",
        thread_ts: "111.222",
        ts: "123.456",
      }),
    });
  }

  async function runChannelMessageEvent(
    text: string,
    overrides: Partial<SlackMessageEvent> = {},
  ): Promise<void> {
    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        channel_type: "channel",
        text,
        ...overrides,
      }),
    });
  }

  function setHistoryCaptureConfig(channels: Record<string, unknown>) {
    slackTestState.config = {
      channels: {
        slack: {
          channels,
          dm: { allowFrom: ["*"], enabled: true, policy: "open" },
          historyLimit: 5,
        },
      },
      messages: { ackReactionScope: "group-mentions" },
    };
  }

  function captureReplyContexts<T extends Record<string, unknown>>() {
    const contexts: T[] = [];
    replyMock.mockImplementation(async (ctx: unknown) => {
      contexts.push((ctx ?? {}) as T);
      return undefined;
    });
    return contexts;
  }

  async function runMonitoredSlackMessages(events: SlackMessageEvent[]) {
    const { controller, run } = startSlackMonitor(monitorSlackProvider);
    const handler = await getSlackHandlerOrThrow("message");
    for (const event of events) {
      await handler({ event });
    }
    await stopSlackMonitor({ controller, run });
  }

  function setPairingOnlyDirectMessages() {
    const currentConfig = slackTestState.config as {
      channels?: { slack?: Record<string, unknown> };
    };
    slackTestState.config = {
      ...currentConfig,
      channels: {
        ...currentConfig.channels,
        slack: {
          ...currentConfig.channels?.slack,
          dm: { allowFrom: [], enabled: true, policy: "pairing" },
        },
      },
    };
  }

  function setOpenChannelDirectMessages(params?: {
    bindings?: Record<string, unknown>[];
    groupPolicy?: "open";
    includeAckReactionConfig?: boolean;
    replyToMode?: "off" | "all" | "first";
    threadInheritParent?: boolean;
  }) {
    const slackChannelConfig: Record<string, unknown> = {
      channels: { C1: { allow: true, requireMention: false } },
      dm: { allowFrom: ["*"], enabled: true, policy: "open" },
      ...(params?.groupPolicy ? { groupPolicy: params.groupPolicy } : {}),
      ...(params?.replyToMode ? { replyToMode: params.replyToMode } : {}),
      ...(params?.threadInheritParent ? { thread: { inheritParent: true } } : {}),
    };
    slackTestState.config = {
      channels: { slack: slackChannelConfig },
      messages: params?.includeAckReactionConfig
        ? {
            ackReaction: "👀",
            ackReactionScope: "group-mentions",
            responsePrefix: "PFX",
          }
        : { responsePrefix: "PFX" },
      ...(params?.bindings ? { bindings: params.bindings } : {}),
    };
  }

  function getFirstReplySessionCtx(): {
    SessionKey?: string;
    ParentSessionKey?: string;
    ThreadStarterBody?: string;
    ThreadLabel?: string;
  } {
    return (replyMock.mock.calls[0]?.[0] ?? {}) as {
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    };
  }

  function expectSingleSendWithThread(threadTs: string | undefined) {
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((sendMock.mock.calls[0]?.[2] as { threadTs?: string } | undefined)?.threadTs).toBe(
      threadTs,
    );
  }

  function setMentionGatedAckConfig(statusReactionsEnabled: boolean) {
    slackTestState.config = {
      channels: {
        slack: {
          dm: { allowFrom: ["*"], enabled: true, policy: "open" },
          groupPolicy: "open",
        },
      },
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
        removeAckAfterReply: true,
        responsePrefix: "PFX",
        statusReactions: statusReactionsEnabled
          ? { enabled: true, timing: { debounceMs: 0, doneHoldMs: 0, errorHoldMs: 0 } }
          : { enabled: false },
      },
    };
  }

  function mockGeneralChannelInfo() {
    const client = getSlackClient();
    if (!client) {
      throw new Error("Slack client not registered");
    }
    const conversations = client.conversations as {
      info: ReturnType<typeof vi.fn>;
    };
    conversations.info.mockResolvedValueOnce({
      channel: { is_channel: true, name: "general" },
    });
  }

  async function runMentionGatedChannelMessageAndFlush() {
    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        channel_type: "channel",
        text: "<@bot-user> hello",
        ts: "456",
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
  }

  function expectReactionNames(names: string[]) {
    expect(reactMock.mock.calls.map(([args]) => String((args as { name: string }).name))).toEqual(
      names,
    );
  }

  async function runDefaultMessageAndExpectSentText(expectedText: string) {
    replyMock.mockResolvedValue({ text: expectedText.replace(/^PFX /, "") });
    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent(),
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toBe(expectedText);
  }

  it("skips socket startup when Slack channel is disabled", async () => {
    slackTestState.config = {
      channels: {
        slack: {
          appToken: "xapp-config",
          botToken: "xoxb-config",
          enabled: false,
          mode: "socket",
        },
      },
    };
    const client = getSlackClient();
    if (!client) {
      throw new Error("Slack client not registered");
    }
    client.auth.test.mockClear();

    const { controller, run } = startSlackMonitor(monitorSlackProvider);
    await flush();
    controller.abort();
    await run;

    expect(client.auth.test).not.toHaveBeenCalled();
    expect(getSlackHandlers()?.size ?? 0).toBe(0);
  });

  it("skips tool summaries with responsePrefix", async () => {
    await runDefaultMessageAndExpectSentText("PFX final reply");
  });

  it("drops events with mismatched api_app_id", async () => {
    const client = getSlackClient();
    if (!client) {
      throw new Error("Slack client not registered");
    }
    (client.auth as { test: ReturnType<typeof vi.fn> }).test.mockResolvedValue({
      api_app_id: "A1",
      team_id: "T1",
      user_id: "bot-user",
    });

    await runSlackMessageOnce(
      monitorSlackProvider,
      {
        body: { api_app_id: "A2", team_id: "T1" },
        event: makeSlackMessageEvent(),
      },
      { appToken: "xapp-1-A1-abc" },
    );

    expect(sendMock).not.toHaveBeenCalled();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it("does not derive responsePrefix from routed agent identity when unset", async () => {
    slackTestState.config = {
      agents: {
        list: [
          {
            default: true,
            id: "main",
            identity: { emoji: "🦞", name: "Mainbot", theme: "space lobster" },
          },
          {
            id: "rich",
            identity: { emoji: "🦁", name: "Richbot", theme: "lion bot" },
          },
        ],
      },
      bindings: [
        {
          agentId: "rich",
          match: { channel: "slack", peer: { id: "U1", kind: "direct" } },
        },
      ],
      channels: {
        slack: { dm: { allowFrom: ["*"], enabled: true, policy: "open" } },
      },
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
    };

    await runDefaultMessageAndExpectSentText("final reply");
  });

  it("preserves RawBody without injecting processed room history", async () => {
    setHistoryCaptureConfig({ "*": { requireMention: false } });
    const capturedCtx = captureReplyContexts<{
      Body?: string;
      RawBody?: string;
      CommandBody?: string;
    }>();
    await runMonitoredSlackMessages([
      makeSlackMessageEvent({ channel_type: "channel", text: "first", ts: "123", user: "U1" }),
      makeSlackMessageEvent({ channel_type: "channel", text: "second", ts: "124", user: "U2" }),
    ]);

    expect(replyMock).toHaveBeenCalledTimes(2);
    const latestCtx = capturedCtx.at(-1) ?? {};
    expect(latestCtx.Body).not.toContain(HISTORY_CONTEXT_MARKER);
    expect(latestCtx.Body).not.toContain(CURRENT_MESSAGE_MARKER);
    expect(latestCtx.Body).not.toContain("first");
    expect(latestCtx.RawBody).toBe("second");
    expect(latestCtx.CommandBody).toBe("second");
  });

  it("scopes thread history to the thread by default", async () => {
    setHistoryCaptureConfig({ C1: { allow: true, requireMention: true } });
    const capturedCtx = captureReplyContexts<{ Body?: string }>();
    await runMonitoredSlackMessages([
      makeSlackMessageEvent({
        channel_type: "channel",
        text: "thread-a-one",
        thread_ts: "100",
        ts: "200",
        user: "U1",
      }),
      makeSlackMessageEvent({
        channel_type: "channel",
        text: "<@bot-user> thread-a-two",
        thread_ts: "100",
        ts: "201",
        user: "U1",
      }),
      makeSlackMessageEvent({
        channel_type: "channel",
        text: "<@bot-user> thread-b-one",
        thread_ts: "300",
        ts: "301",
        user: "U2",
      }),
    ]);

    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(capturedCtx[0]?.Body).toContain("thread-a-one");
    expect(capturedCtx[1]?.Body).not.toContain("thread-a-one");
    expect(capturedCtx[1]?.Body).not.toContain("thread-a-two");
  });

  it("updates assistant thread status when replies start", async () => {
    replyMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[1] ?? {}) as { onReplyStart?: () => Promise<void> | void };
      await opts?.onReplyStart?.();
      return { text: "final reply" };
    });

    setDirectMessageReplyMode("all");
    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent(),
    });

    const client = getSlackClient() as {
      assistant?: { threads?: { setStatus?: ReturnType<typeof vi.fn> } };
    };
    const setStatus = client.assistant?.threads?.setStatus;
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenNthCalledWith(1, {
      channel_id: "C1",
      status: "is typing...",
      thread_ts: "123",
      token: "bot-token",
    });
    expect(setStatus).toHaveBeenNthCalledWith(2, {
      channel_id: "C1",
      status: "",
      thread_ts: "123",
      token: "bot-token",
    });
  });

  async function expectMentionPatternMessageAccepted(text: string): Promise<void> {
    setRequireMentionChannelConfig([String.raw`\bopenclaw\b`]);
    replyMock.mockResolvedValue({ text: "hi" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        channel_type: "channel",
        text,
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(firstReplyCtx().WasMentioned).toBe(true);
  }

  it("accepts channel messages when mentionPatterns match", async () => {
    await expectMentionPatternMessageAccepted("openclaw: hello");
  });

  it("accepts channel messages when mentionPatterns match even if another user is mentioned", async () => {
    await expectMentionPatternMessageAccepted("openclaw: hello <@U2>");
  });

  it("treats replies to bot threads as implicit mentions", async () => {
    setRequireMentionChannelConfig();
    replyMock.mockResolvedValue({ text: "hi" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        channel_type: "channel",
        parent_user_id: "bot-user",
        text: "following up",
        thread_ts: "123",
        ts: "124",
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(firstReplyCtx().WasMentioned).toBe(true);
  });

  it("accepts channel messages without mention when channels.slack.requireMention is false", async () => {
    slackTestState.config = {
      channels: {
        slack: {
          dm: { allowFrom: ["*"], enabled: true, policy: "open" },
          groupPolicy: "open",
          requireMention: false,
        },
      },
    };
    replyMock.mockResolvedValue({ text: "hi" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        channel_type: "channel",
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(firstReplyCtx().WasMentioned).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("treats control commands as mentions for group bypass", async () => {
    replyMock.mockResolvedValue({ text: "ok" });
    await runChannelMessageEvent("/elevated off");

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(firstReplyCtx().WasMentioned).toBe(true);
  });

  it("threads replies when incoming message is in a thread", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });
    setOpenChannelDirectMessages({
      groupPolicy: "open",
      includeAckReactionConfig: true,
      replyToMode: "off",
    });
    await runChannelThreadReplyEvent();

    expectSingleSendWithThread("111.222");
  });

  it("ignores replyToId directive when replyToMode is off", async () => {
    replyMock.mockResolvedValue({ replyToId: "555", text: "forced reply" });
    slackTestState.config = {
      channels: {
        slack: {
          allowFrom: ["*"],
          dm: { enabled: true },
          dmPolicy: "open",
          replyToMode: "off",
        },
      },
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
        responsePrefix: "PFX",
      },
    };

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        ts: "789",
      }),
    });

    expectSingleSendWithThread(undefined);
  });

  it("keeps replyToId directive threading when replyToMode is all", async () => {
    replyMock.mockResolvedValue({ replyToId: "555", text: "forced reply" });
    setDirectMessageReplyMode("all");

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        ts: "789",
      }),
    });

    expectSingleSendWithThread("555");
  });

  it("reacts to mention-gated room messages when ackReaction is enabled", async () => {
    replyMock.mockResolvedValue(undefined);
    const client = getSlackClient();
    if (!client) {
      throw new Error("Slack client not registered");
    }
    const conversations = client.conversations as {
      info: ReturnType<typeof vi.fn>;
    };
    conversations.info.mockResolvedValueOnce({
      channel: { is_channel: true, name: "general" },
    });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        channel_type: "channel",
        text: "<@bot-user> hello",
        ts: "456",
      }),
    });

    expect(reactMock).toHaveBeenCalledWith({
      channel: "C1",
      name: "eyes",
      timestamp: "456",
    });
  });

  it("keeps ack reaction when no reply is delivered and status reactions are disabled", async () => {
    replyMock.mockResolvedValue(undefined);
    setMentionGatedAckConfig(false);
    mockGeneralChannelInfo();
    await runMentionGatedChannelMessageAndFlush();

    expect(sendMock).not.toHaveBeenCalled();
    expect(reactMock).toHaveBeenCalledTimes(1);
    expect(reactMock).toHaveBeenCalledWith({
      channel: "C1",
      name: "👀",
      timestamp: "456",
    });
  });

  it("keeps ack reaction when no reply is delivered and status reactions are enabled", async () => {
    replyMock.mockResolvedValue(undefined);
    setMentionGatedAckConfig(true);
    mockGeneralChannelInfo();
    await runMentionGatedChannelMessageAndFlush();

    expect(sendMock).not.toHaveBeenCalled();
    expect(reactMock).toHaveBeenCalledTimes(1);
    expect(reactMock).toHaveBeenCalledWith({
      channel: "C1",
      name: "eyes",
      timestamp: "456",
    });
  });

  it("restores ack reaction when dispatch fails before any reply is delivered", async () => {
    replyMock.mockRejectedValue(new Error("boom"));
    setMentionGatedAckConfig(true);
    mockGeneralChannelInfo();
    await runMentionGatedChannelMessageAndFlush();

    expect(sendMock).not.toHaveBeenCalled();
    expectReactionNames(["eyes", "scream", "eyes", "eyes", "scream"]);
  });

  it("replies with pairing code when dmPolicy is pairing and no allowFrom is set", async () => {
    setPairingOnlyDirectMessages();

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent(),
    });

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sentText = sendMock.mock.calls[0]?.[1];
    expectPairingReplyText(typeof sentText === "string" ? sentText : "", {
      channel: "slack",
      code: "PAIRCODE",
      idLine: "Your Slack user id: U1",
    });
  });

  it("does not resend pairing code when a request is already pending", async () => {
    setPairingOnlyDirectMessages();
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    const { controller, run } = startSlackMonitor(monitorSlackProvider);
    const handler = await getSlackHandlerOrThrow("message");

    const baseEvent = makeSlackMessageEvent();

    await handler({ event: baseEvent });
    await handler({ event: { ...baseEvent, text: "hello again", ts: "124" } });

    await stopSlackMonitor({ controller, run });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("threads top-level replies when replyToMode is all", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });
    setDirectMessageReplyMode("all");
    await runDirectMessageEvent("123");

    expectSingleSendWithThread("123");
  });

  it("treats parent_user_id as a thread reply even when thread_ts matches ts", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        parent_user_id: "U2",
        thread_ts: "123",
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = getFirstReplySessionCtx();
    expect(ctx.SessionKey).toBe("agent:main:main:thread:123");
    expect(ctx.ParentSessionKey).toBeUndefined();
  });

  it("keeps thread parent inheritance opt-in", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });
    setOpenChannelDirectMessages({ threadInheritParent: true });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        channel_type: "channel",
        thread_ts: "111.222",
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = getFirstReplySessionCtx();
    expect(ctx.SessionKey).toBe("agent:main:slack:channel:c1:thread:111.222");
    expect(ctx.ParentSessionKey).toBe("agent:main:slack:channel:c1");
  });

  it("injects starter context for thread replies", async () => {
    replyMock.mockResolvedValue({ text: "ok" });

    const client = getSlackClient();
    if (client?.conversations?.info) {
      client.conversations.info.mockResolvedValue({
        channel: { is_channel: true, name: "general" },
      });
    }
    if (client?.conversations?.replies) {
      client.conversations.replies.mockResolvedValue({
        messages: [{ text: "starter message", ts: "111.222", user: "U2" }],
      });
    }

    setOpenChannelDirectMessages();

    await runChannelThreadReplyEvent();

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = getFirstReplySessionCtx();
    expect(ctx.SessionKey).toBe("agent:main:slack:channel:c1:thread:111.222");
    expect(ctx.ParentSessionKey).toBeUndefined();
    expect(ctx.ThreadStarterBody).toContain("starter message");
    expect(ctx.ThreadLabel).toContain("Slack thread #general");
  });

  it("scopes thread session keys to the routed agent", async () => {
    replyMock.mockResolvedValue({ text: "ok" });
    setOpenChannelDirectMessages({
      bindings: [{ agentId: "support", match: { channel: "slack", teamId: "T1" } }],
    });

    const client = getSlackClient();
    if (client?.auth?.test) {
      client.auth.test.mockResolvedValue({
        team_id: "T1",
        user_id: "bot-user",
      });
    }
    if (client?.conversations?.info) {
      client.conversations.info.mockResolvedValue({
        channel: { is_channel: true, name: "general" },
      });
    }

    await runChannelThreadReplyEvent();

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = getFirstReplySessionCtx();
    expect(ctx.SessionKey).toBe("agent:support:slack:channel:c1:thread:111.222");
    expect(ctx.ParentSessionKey).toBeUndefined();
  });

  it("keeps replies in channel root when message is not threaded (replyToMode off)", async () => {
    replyMock.mockResolvedValue({ text: "root reply" });
    setDirectMessageReplyMode("off");
    await runDirectMessageEvent("789");

    expectSingleSendWithThread(undefined);
  });

  it("threads first reply when replyToMode is first and message is not threaded", async () => {
    replyMock.mockResolvedValue({ text: "first reply" });
    setDirectMessageReplyMode("first");
    await runDirectMessageEvent("789");

    expectSingleSendWithThread("789");
  });
});
