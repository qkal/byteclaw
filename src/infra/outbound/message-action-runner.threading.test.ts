import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  prepareOutboundMirrorRoute,
  resolveAndApplyOutboundThreadId,
} from "./message-action-threading.js";

const ensureOutboundSessionEntry = vi.fn(async () => undefined);
const resolveOutboundSessionRoute = vi.fn();

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
    },
  },
} as OpenClawConfig;

const telegramConfig = {
  channels: {
    telegram: {
      botToken: "telegram-test",
    },
  },
} as OpenClawConfig;

const defaultTelegramToolContext = {
  currentChannelId: "telegram:123",
  currentThreadTs: "42",
} as const;

describe("message action threading helpers", () => {
  beforeEach(() => {
    ensureOutboundSessionEntry.mockClear();
    resolveOutboundSessionRoute.mockReset();
  });

  it.each([
    {
      expectedSessionKey: "agent:main:slack:channel:c123:thread:111.222",
      name: "exact channel id",
      target: "channel:C123",
      threadTs: "111.222",
    },
    {
      expectedSessionKey: "agent:main:slack:channel:c123:thread:333.444",
      name: "case-insensitive channel id",
      target: "channel:c123",
      threadTs: "333.444",
    },
  ] as const)("prepares outbound routes for slack using $name", async (testCase) => {
    const actionParams: Record<string, unknown> = {
      channel: "slack",
      message: "hi",
      target: testCase.target,
    };
    resolveOutboundSessionRoute.mockResolvedValue({
      baseSessionKey: "base",
      chatType: "channel",
      from: "from",
      peer: { id: "peer", kind: "channel" },
      sessionKey: testCase.expectedSessionKey,
      threadId: testCase.threadTs,
      to: testCase.target,
    });

    const result = await prepareOutboundMirrorRoute({
      actionParams,
      agentId: "main",
      cfg: slackConfig,
      channel: "slack",
      ensureOutboundSessionEntry,
      resolveAutoThreadId: ({ toolContext }) => toolContext?.currentThreadTs,
      resolveOutboundSessionRoute,
      to: testCase.target,
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: testCase.threadTs,
        replyToMode: "all",
      },
    });

    expect(result.outboundRoute?.sessionKey).toBe(testCase.expectedSessionKey);
    expect(actionParams.__sessionKey).toBe(testCase.expectedSessionKey);
    expect(actionParams.__agentId).toBe("main");
    expect(ensureOutboundSessionEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      expectedThreadId: "42",
      name: "injects threadId for matching target",
      target: "telegram:123",
    },
    {
      expectedThreadId: "42",
      name: "injects threadId for prefixed group target",
      target: "telegram:group:123",
    },
    {
      expectedThreadId: undefined,
      name: "skips threadId when target chat differs",
      target: "telegram:999",
    },
  ] as const)("telegram auto-threading: $name", (testCase) => {
    const actionParams: Record<string, unknown> = {
      channel: "telegram",
      message: "hi",
      target: testCase.target,
    };

    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      cfg: telegramConfig,
      resolveAutoThreadId: ({ to, toolContext }) =>
        to.includes("123") ? toolContext?.currentThreadTs : undefined,
      to: testCase.target,
      toolContext: defaultTelegramToolContext,
    });

    expect(actionParams.threadId).toBe(testCase.expectedThreadId);
    expect(resolved).toBe(testCase.expectedThreadId);
  });

  it("uses explicit telegram threadId when provided", () => {
    const actionParams: Record<string, unknown> = {
      channel: "telegram",
      message: "hi",
      target: "telegram:123",
      threadId: "999",
    };

    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      cfg: telegramConfig,
      resolveAutoThreadId: () => "42",
      to: "telegram:123",
      toolContext: defaultTelegramToolContext,
    });

    expect(actionParams.threadId).toBe("999");
    expect(resolved).toBe("999");
  });

  it("passes explicit replyTo into auto-thread resolution", () => {
    const resolveAutoThreadId = vi.fn(() => "thread-777");
    const actionParams: Record<string, unknown> = {
      channel: "telegram",
      message: "hi",
      replyTo: "777",
      target: "telegram:123",
    };

    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      cfg: telegramConfig,
      resolveAutoThreadId,
      to: "telegram:123",
      toolContext: defaultTelegramToolContext,
    });

    expect(resolveAutoThreadId).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToId: "777",
      }),
    );
    expect(resolved).toBe("thread-777");
    expect(actionParams.threadId).toBe("thread-777");
  });
});
