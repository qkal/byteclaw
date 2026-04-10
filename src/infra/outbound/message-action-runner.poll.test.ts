import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const mocks = vi.hoisted(() => ({
  executePollAction: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("./channel-resolution.js", () => ({
  resetOutboundChannelResolutionStateForTest: vi.fn(),
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

vi.mock("./outbound-send-service.js", () => ({
  executePollAction: mocks.executePollAction,
  executeSendAction: vi.fn(async () => {
    throw new Error("executeSendAction should not run in poll tests");
  }),
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("./message-action-threading.js", async () => {
  const { createOutboundThreadingMock } =
    await import("./message-action-threading.test-helpers.js");
  return createOutboundThreadingMock();
});
const telegramConfig = {
  channels: {
    telegram: {
      botToken: "telegram-test",
    },
  },
} as OpenClawConfig;

const telegramPollTestPlugin: ChannelPlugin = {
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    isConfigured: () => true,
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ botToken: "telegram-test" }),
  },
  id: "telegram",
  messaging: {
    targetResolver: {
      looksLikeId: () => true,
      resolveTarget: async ({ normalized }) => ({
        kind: "user",
        source: "normalized",
        to: normalized,
      }),
    },
  },
  meta: {
    blurb: "Telegram poll test plugin.",
    docsPath: "/channels/telegram",
    id: "telegram",
    label: "Telegram",
    selectionLabel: "Telegram",
  },
  outbound: {
    deliveryMode: "gateway",
    sendPoll: async () => ({
      messageId: "poll-test",
    }),
  },
  threading: {
    resolveAutoThreadId: ({ toolContext, to, replyToId }) => {
      if (replyToId) {
        return undefined;
      }
      if (toolContext?.currentChannelId !== to) {
        return undefined;
      }
      return toolContext.currentThreadTs;
    },
  },
};

async function runPollAction(params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
}) {
  await runMessageAction({
    action: "poll",
    cfg: params.cfg,
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
  });
  const call = mocks.executePollAction.mock.calls[0]?.[0] as
    | {
        resolveCorePoll?: () => {
          durationHours?: number;
          maxSelections?: number;
          threadId?: string;
        };
        ctx?: { params?: Record<string, unknown> };
      }
    | undefined;
  if (!call) {
    return undefined;
  }
  return {
    ...call.resolveCorePoll?.(),
    ctx: call.ctx,
  };
}

describe("runMessageAction poll handling", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: telegramPollTestPlugin,
          pluginId: "telegram",
          source: "test",
        },
      ]),
    );
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel }: { channel: string }) =>
        getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
    );
    mocks.executePollAction.mockReset();
    mocks.executePollAction.mockImplementation(async (input) => ({
      handledBy: "core",
      payload: { corePoll: input.resolveCorePoll(), ok: true },
      pollResult: { ok: true },
    }));
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    mocks.executePollAction.mockReset();
  });

  it("requires at least two poll options", async () => {
    await expect(
      runPollAction({
        actionParams: {
          channel: "telegram",
          pollOption: ["Pizza"],
          pollQuestion: "Lunch?",
          target: "telegram:123",
        },
        cfg: telegramConfig,
      }),
    ).rejects.toThrow(/pollOption requires at least two values/i);
    expect(mocks.executePollAction).toHaveBeenCalledTimes(1);
  });

  it("passes shared poll fields and auto threadId to executePollAction", async () => {
    const call = await runPollAction({
      actionParams: {
        channel: "telegram",
        pollDurationHours: 2,
        pollOption: ["Pizza", "Sushi"],
        pollQuestion: "Lunch?",
        target: "telegram:123",
      },
      cfg: telegramConfig,
      toolContext: {
        currentChannelId: "telegram:123",
        currentThreadTs: "42",
      },
    });

    expect(call?.durationHours).toBe(2);
    expect(call?.threadId).toBe("42");
    expect(call?.ctx?.params?.threadId).toBe("42");
  });

  it("expands maxSelections when pollMulti is enabled", async () => {
    const call = await runPollAction({
      actionParams: {
        channel: "telegram",
        pollMulti: true,
        pollOption: ["Pizza", "Sushi", "Soup"],
        pollQuestion: "Lunch?",
        target: "telegram:123",
      },
      cfg: telegramConfig,
    });

    expect(call?.maxSelections).toBe(3);
  });

  it("defaults maxSelections to one choice when pollMulti is omitted", async () => {
    const call = await runPollAction({
      actionParams: {
        channel: "telegram",
        pollOption: ["Pizza", "Sushi", "Soup"],
        pollQuestion: "Lunch?",
        target: "telegram:123",
      },
      cfg: telegramConfig,
    });

    expect(call?.maxSelections).toBe(1);
  });
});
