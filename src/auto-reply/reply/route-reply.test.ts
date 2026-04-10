import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelMessagingAdapter,
  ChannelPlugin,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/outbound/deliver-runtime.js")>(
    "../../infra/outbound/deliver-runtime.js",
  );
  return {
    ...actual,
    deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  };
});

const { routeReply } = await import("./route-reply.js");

function compileSlackInteractiveRepliesForTest(
  payload: Parameters<NonNullable<ChannelMessagingAdapter["transformReplyPayload"]>>[0]["payload"],
) {
  const text = payload.text ?? "";
  if (!text.includes("[[slack_select:") && !text.includes("[[slack_buttons:")) {
    return payload;
  }
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      slack: {
        ...(payload.channelData?.slack as Record<string, unknown> | undefined),
        blocks: [{ text, type: "section" }],
      },
    },
  };
}

const slackMessaging: ChannelMessagingAdapter = {
  enableInteractiveReplies: ({ cfg }) =>
    (cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } } | undefined)
      ?.capabilities?.interactiveReplies === true,
  hasStructuredReplyPayload: ({ payload }) => {
    const blocks = (payload.channelData?.slack as { blocks?: unknown } | undefined)?.blocks;
    if (typeof blocks === "string") {
      return blocks.trim().length > 0;
    }
    return Array.isArray(blocks) && blocks.length > 0;
  },
  transformReplyPayload: ({ payload, cfg }) =>
    (cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } } | undefined)
      ?.capabilities?.interactiveReplies === true
      ? compileSlackInteractiveRepliesForTest(payload)
      : payload,
};

const slackThreading: ChannelThreadingAdapter = {
  resolveReplyTransport: ({ threadId, replyToId }) => ({
    replyToId: replyToId ?? (threadId != null && threadId !== "" ? String(threadId) : undefined),
    threadId: null,
  }),
};

const mattermostThreading: ChannelThreadingAdapter = {
  resolveReplyTransport: ({ threadId, replyToId }) => ({
    replyToId: replyToId ?? (threadId != null && threadId !== "" ? String(threadId) : undefined),
    threadId,
  }),
};

function createChannelPlugin(
  id: ChannelPlugin["id"],
  options: {
    messaging?: ChannelMessagingAdapter;
    threading?: ChannelThreadingAdapter;
    label?: string;
  } = {},
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      config: { listAccountIds: () => [], resolveAccount: () => ({}) },
      id,
      label: options.label ?? String(id),
    }),
    ...(options.messaging ? { messaging: options.messaging } : {}),
    ...(options.threading ? { threading: options.threading } : {}),
  };
}

function expectLastDelivery(
  matcher: Partial<Parameters<(typeof mocks.deliverOutboundPayloads.mock.calls)[number][0]>[0]>,
) {
  expect(mocks.deliverOutboundPayloads).toHaveBeenLastCalledWith(expect.objectContaining(matcher));
}

async function expectSlackNoDelivery(
  payload: Parameters<typeof routeReply>[0]["payload"],
  overrides: Partial<Parameters<typeof routeReply>[0]> = {},
) {
  mocks.deliverOutboundPayloads.mockClear();
  const res = await routeReply({
    cfg: {} as never,
    channel: "slack",
    payload,
    to: "channel:C123",
    ...overrides,
  });
  expect(res.ok).toBe(true);
  expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  return res;
}

describe("routeReply", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: createChannelPlugin("discord", { label: "Discord" }),
          pluginId: "discord",
          source: "test",
        },
        {
          plugin: createChannelPlugin("slack", {
            label: "Slack",
            messaging: slackMessaging,
            threading: slackThreading,
          }),
          pluginId: "slack",
          source: "test",
        },
        {
          plugin: createChannelPlugin("telegram", { label: "Telegram" }),
          pluginId: "telegram",
          source: "test",
        },
        {
          plugin: createChannelPlugin("whatsapp", { label: "WhatsApp" }),
          pluginId: "whatsapp",
          source: "test",
        },
        {
          plugin: createChannelPlugin("signal", { label: "Signal" }),
          pluginId: "signal",
          source: "test",
        },
        {
          plugin: createChannelPlugin("imessage", { label: "iMessage" }),
          pluginId: "imessage",
          source: "test",
        },
        {
          plugin: createChannelPlugin("msteams", { label: "Microsoft Teams" }),
          pluginId: "msteams",
          source: "test",
        },
        {
          plugin: createChannelPlugin("mattermost", {
            label: "Mattermost",
            threading: mattermostThreading,
          }),
          pluginId: "mattermost",
          source: "test",
        },
      ]),
    );
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("skips sends when abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await routeReply({
      abortSignal: controller.signal,
      cfg: {} as never,
      channel: "slack",
      payload: { text: "hi" },
      to: "channel:C123",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("aborted");
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("no-ops on empty payload", async () => {
    await expectSlackNoDelivery({});
  });

  it("suppresses reasoning payloads", async () => {
    await expectSlackNoDelivery({ isReasoning: true, text: "Reasoning:\n_step_" });
  });

  it("drops silent token payloads", async () => {
    await expectSlackNoDelivery({ text: SILENT_REPLY_TOKEN });
  });

  it("does not drop payloads that merely start with the silent token", async () => {
    const res = await routeReply({
      cfg: {} as never,
      channel: "slack",
      payload: { text: `${SILENT_REPLY_TOKEN} -- (why am I here?)` },
      to: "channel:C123",
    });
    expect(res.ok).toBe(true);
    expectLastDelivery({
      channel: "slack",
      payloads: [
        expect.objectContaining({
          text: `${SILENT_REPLY_TOKEN} -- (why am I here?)`,
        }),
      ],
      to: "channel:C123",
    });
  });

  it("applies responsePrefix when routing", async () => {
    const cfg = {
      messages: { responsePrefix: "[openclaw]" },
    } as unknown as OpenClawConfig;
    await routeReply({
      cfg,
      channel: "slack",
      payload: { text: "hi" },
      to: "channel:C123",
    });
    expectLastDelivery({
      payloads: [expect.objectContaining({ text: "[openclaw] hi" })],
    });
  });

  it("routes directive-only Slack replies when interactive replies are enabled", async () => {
    const cfg = {
      channels: {
        slack: {
          capabilities: { interactiveReplies: true },
        },
      },
    } as unknown as OpenClawConfig;
    await routeReply({
      cfg,
      channel: "slack",
      payload: { text: "[[slack_select: Choose one | Alpha:alpha]]" },
      to: "channel:C123",
    });
    expectLastDelivery({
      payloads: [
        expect.objectContaining({
          text: "[[slack_select: Choose one | Alpha:alpha]]",
        }),
      ],
    });
  });

  it("does not bypass the empty-reply guard for invalid Slack blocks", async () => {
    await expectSlackNoDelivery({
      channelData: {
        slack: {
          blocks: " ",
        },
      },
      text: " ",
    });
  });

  it("does not derive responsePrefix from agent identity when routing", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "rich",
            identity: { emoji: "lion", name: "Richbot", theme: "lion bot" },
          },
        ],
      },
      messages: {},
    } as unknown as OpenClawConfig;
    await routeReply({
      cfg,
      channel: "slack",
      payload: { text: "hi" },
      sessionKey: "agent:rich:main",
      to: "channel:C123",
    });
    expectLastDelivery({
      payloads: [expect.objectContaining({ text: "hi" })],
    });
  });

  it("uses threadId for Slack when replyToId is missing", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "slack",
      payload: { text: "hi" },
      threadId: "456.789",
      to: "channel:C123",
    });
    expectLastDelivery({
      channel: "slack",
      replyToId: "456.789",
      threadId: null,
    });
  });

  it("passes thread id to Telegram sends", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "telegram",
      payload: { text: "hi" },
      threadId: 42,
      to: "telegram:123",
    });
    expectLastDelivery({
      channel: "telegram",
      threadId: 42,
      to: "telegram:123",
    });
  });

  it("formats BTW replies prominently on routed sends", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "slack",
      payload: { btw: { question: "what is 17 * 19?" }, text: "323" },
      to: "channel:C123",
    });
    expectLastDelivery({
      channel: "slack",
      payloads: [expect.objectContaining({ text: "BTW\nQuestion: what is 17 * 19?\n\n323" })],
    });
  });

  it("formats BTW replies prominently on routed discord sends", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "discord",
      payload: { btw: { question: "what is 17 * 19?" }, text: "323" },
      to: "channel:123456",
    });
    expectLastDelivery({
      channel: "discord",
      payloads: [expect.objectContaining({ text: "BTW\nQuestion: what is 17 * 19?\n\n323" })],
    });
  });

  it("passes replyToId to Telegram sends", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "telegram",
      payload: { replyToId: "123", text: "hi" },
      to: "telegram:123",
    });
    expectLastDelivery({
      channel: "telegram",
      replyToId: "123",
      to: "telegram:123",
    });
  });

  it("preserves audioAsVoice on routed outbound payloads", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "slack",
      payload: { audioAsVoice: true, mediaUrl: "file:///tmp/clip.mp3", text: "voice caption" },
      to: "channel:C123",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectLastDelivery({
      channel: "slack",
      payloads: [
        expect.objectContaining({
          audioAsVoice: true,
          mediaUrl: "file:///tmp/clip.mp3",
          text: "voice caption",
        }),
      ],
      to: "channel:C123",
    });
  });

  it("uses replyToId as threadTs for Slack", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "slack",
      payload: { replyToId: "1710000000.0001", text: "hi" },
      to: "channel:C123",
    });
    expectLastDelivery({
      channel: "slack",
      replyToId: "1710000000.0001",
      threadId: null,
    });
  });

  it("uses threadId as threadTs for Slack when replyToId is missing", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "slack",
      payload: { text: "hi" },
      threadId: "1710000000.9999",
      to: "channel:C123",
    });
    expectLastDelivery({
      channel: "slack",
      replyToId: "1710000000.9999",
      threadId: null,
    });
  });

  it("uses threadId as replyToId for Mattermost when replyToId is missing", async () => {
    await routeReply({
      cfg: {
        channels: {
          mattermost: {
            baseUrl: "https://chat.example.com",
            botToken: "test-token",
            enabled: true,
          },
        },
      } as unknown as OpenClawConfig,
      channel: "mattermost",
      payload: { text: "hi" },
      threadId: "post-root",
      to: "channel:CHAN1",
    });
    expectLastDelivery({
      channel: "mattermost",
      replyToId: "post-root",
      threadId: "post-root",
      to: "channel:CHAN1",
    });
  });

  it("preserves multiple mediaUrls as a single outbound payload", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "slack",
      payload: { mediaUrls: ["a", "b"], text: "caption" },
      to: "channel:C123",
    });
    expectLastDelivery({
      channel: "slack",
      payloads: [
        expect.objectContaining({
          mediaUrls: ["a", "b"],
          text: "caption",
        }),
      ],
    });
  });

  it("routes WhatsApp with the account id intact", async () => {
    await routeReply({
      accountId: "acc-1",
      cfg: {} as never,
      channel: "whatsapp",
      payload: { text: "hi" },
      to: "+15551234567",
    });
    expectLastDelivery({
      accountId: "acc-1",
      channel: "whatsapp",
      to: "+15551234567",
    });
  });

  it("routes MS Teams via outbound delivery", async () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
        },
      },
    } as unknown as OpenClawConfig;
    await routeReply({
      cfg,
      channel: "msteams",
      payload: { text: "hi" },
      to: "conversation:19:abc@thread.tacv2",
    });
    expectLastDelivery({
      cfg,
      channel: "msteams",
      payloads: [expect.objectContaining({ text: "hi" })],
      to: "conversation:19:abc@thread.tacv2",
    });
  });

  it("passes mirror data when sessionKey is set", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "slack",
      groupId: "channel:C123",
      isGroup: true,
      payload: { text: "hi" },
      sessionKey: "agent:main:main",
      to: "channel:C123",
    });
    expectLastDelivery({
      mirror: expect.objectContaining({
        groupId: "channel:C123",
        isGroup: true,
        sessionKey: "agent:main:main",
        text: "hi",
      }),
    });
  });

  it("skips mirror data when mirror is false", async () => {
    await routeReply({
      cfg: {} as never,
      channel: "slack",
      mirror: false,
      payload: { text: "hi" },
      sessionKey: "agent:main:main",
      to: "channel:C123",
    });
    expectLastDelivery({
      mirror: undefined,
    });
  });
});
