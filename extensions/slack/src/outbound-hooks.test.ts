import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

let slackOutbound: typeof import("./outbound-adapter.js").slackOutbound;

interface SlackSendTextCtx {
  to: string;
  text: string;
  accountId: string;
  replyToId: string;
  identity?: {
    name?: string;
    avatarUrl?: string;
    emoji?: string;
  };
}

const BASE_SLACK_SEND_CTX = {
  accountId: "default",
  replyToId: "1111.2222",
  to: "C123",
} as const;

const sendSlackText = async (ctx: SlackSendTextCtx) => {
  const {sendText} = slackOutbound;
  if (!sendText) {
    throw new Error("slackOutbound.sendText is unavailable");
  }
  return await sendText({
    cfg: {} as OpenClawConfig,
    ...ctx,
  });
};

const sendSlackTextWithDefaults = async (
  overrides: Partial<SlackSendTextCtx> & Pick<SlackSendTextCtx, "text">,
) => await sendSlackText({
    ...BASE_SLACK_SEND_CTX,
    ...overrides,
  });

const expectSlackSendCalledWith = (
  text: string,
  options?: {
    identity?: {
      username?: string;
      iconUrl?: string;
      iconEmoji?: string;
    };
  },
) => {
  const expected = {
    accountId: "default",
    cfg: expect.any(Object),
    threadTs: "1111.2222",
    ...(options?.identity ? { identity: expect.objectContaining(options.identity) } : {}),
  };
  expect(sendMessageSlackMock).toHaveBeenCalledWith(
    "C123",
    text,
    expect.objectContaining(expected),
  );
};

describe("slack outbound hook wiring", () => {
  beforeAll(async () => {
    ({ slackOutbound } = await import("./outbound-adapter.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageSlackMock.mockResolvedValue({ channelId: "C123", messageId: "1234.5678" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls send without hooks when no hooks registered", async () => {
    getGlobalHookRunnerMock.mockReturnValue(null);

    await sendSlackTextWithDefaults({ text: "hello" });
    expectSlackSendCalledWith("hello");
  });

  it("forwards identity opts when present", async () => {
    getGlobalHookRunnerMock.mockReturnValue(null);

    await sendSlackTextWithDefaults({
      identity: {
        avatarUrl: "https://example.com/avatar.png",
        emoji: ":should_not_send:",
        name: "My Agent",
      },
      text: "hello",
    });

    expectSlackSendCalledWith("hello", {
      identity: { iconUrl: "https://example.com/avatar.png", username: "My Agent" },
    });
  });

  it("forwards icon_emoji only when icon_url is absent", async () => {
    getGlobalHookRunnerMock.mockReturnValue(null);

    await sendSlackTextWithDefaults({
      identity: { emoji: ":lobster:" },
      text: "hello",
    });

    expectSlackSendCalledWith("hello", {
      identity: { iconEmoji: ":lobster:" },
    });
  });

  it("calls message_sending hook before sending", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue(undefined),
    };
    getGlobalHookRunnerMock.mockReturnValue(mockRunner);

    await sendSlackTextWithDefaults({ text: "hello" });

    expect(mockRunner.hasHooks).toHaveBeenCalledWith("message_sending");
    expect(mockRunner.runMessageSending).toHaveBeenCalledWith(
      { content: "hello", metadata: { channelId: "C123", threadTs: "1111.2222" }, to: "C123" },
      { accountId: "default", channelId: "slack" },
    );
    expectSlackSendCalledWith("hello");
  });

  it("uses configured defaultAccount for hook context when accountId is omitted", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue(undefined),
    };
    getGlobalHookRunnerMock.mockReturnValue(mockRunner);

    const {sendText} = slackOutbound;
    if (!sendText) {
      throw new Error("slackOutbound.sendText is unavailable");
    }
    await sendText({
      cfg: {
        channels: {
          slack: {
            accounts: {
              work: {
                botToken: "xoxb-work",
              },
            },
            defaultAccount: "work",
          },
        },
      } as OpenClawConfig,
      replyToId: "1111.2222",
      text: "hello",
      to: "C123",
    });

    expect(mockRunner.runMessageSending).toHaveBeenCalledWith(
      { content: "hello", metadata: { channelId: "C123", threadTs: "1111.2222" }, to: "C123" },
      { accountId: "work", channelId: "slack" },
    );
  });

  it("cancels send when hook returns cancel:true", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue({ cancel: true }),
    };
    getGlobalHookRunnerMock.mockReturnValue(mockRunner);

    const result = await sendSlackTextWithDefaults({ text: "hello" });

    expect(sendMessageSlackMock).not.toHaveBeenCalled();
    expect(result.channel).toBe("slack");
  });

  it("modifies text when hook returns content", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue({ content: "modified" }),
    };
    getGlobalHookRunnerMock.mockReturnValue(mockRunner);

    await sendSlackTextWithDefaults({ text: "original" });
    expectSlackSendCalledWith("modified");
  });

  it("skips hooks when runner has no message_sending hooks", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(false),
      runMessageSending: vi.fn(),
    };
    getGlobalHookRunnerMock.mockReturnValue(mockRunner);

    await sendSlackTextWithDefaults({ text: "hello" });

    expect(mockRunner.runMessageSending).not.toHaveBeenCalled();
    expect(sendMessageSlackMock).toHaveBeenCalled();
  });
});
