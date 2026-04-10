import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  getChannelPlugin: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  resolveRuntimePluginRegistry: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  listChannelPlugins: () => [],
  normalizeChannelId: (channel?: string) => channel?.trim().toLowerCase() ?? undefined,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/tmp/openclaw-test-workspace",
  resolveDefaultAgentId: () => "main",
  resolveSessionAgentId: ({
    sessionKey,
  }: {
    sessionKey?: string;
    config?: unknown;
    agentId?: string;
  }) => {
    const match = sessionKey?.match(/^agent:([^:]+)/i);
    return match?.[1] ?? "main";
  },
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: unknown }) => ({ changes: [], config }),
}));

vi.mock("../../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("./deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

let sendMessage: typeof import("./message.js").sendMessage;
let resetOutboundChannelResolutionStateForTest: typeof import("./channel-resolution.js").resetOutboundChannelResolutionStateForTest;

describe("sendMessage", () => {
  beforeAll(async () => {
    ({ sendMessage } = await import("./message.js"));
    ({ resetOutboundChannelResolutionStateForTest } = await import("./channel-resolution.js"));
  });

  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    resetOutboundChannelResolutionStateForTest();
    mocks.getChannelPlugin.mockClear();
    mocks.resolveOutboundTarget.mockClear();
    mocks.deliverOutboundPayloads.mockClear();
    mocks.resolveRuntimePluginRegistry.mockClear();

    mocks.getChannelPlugin.mockReturnValue({
      outbound: { deliveryMode: "direct" },
    });
    mocks.resolveOutboundTarget.mockImplementation(({ to }: { to: string }) => ({ ok: true, to }));
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "mattermost", messageId: "m1" }]);
  });

  it("passes explicit agentId to outbound delivery for scoped media roots", async () => {
    await sendMessage({
      agentId: "work",
      cfg: {},
      channel: "telegram",
      content: "hi",
      to: "123456",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        session: expect.objectContaining({ agentId: "work" }),
        to: "123456",
      }),
    );
  });

  it("propagates the send idempotency key into mirrored transcript delivery", async () => {
    await sendMessage({
      cfg: {},
      channel: "telegram",
      content: "hi",
      idempotencyKey: "idem-send-1",
      mirror: {
        sessionKey: "agent:main:telegram:dm:123456",
      },
      to: "123456",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          idempotencyKey: "idem-send-1",
          sessionKey: "agent:main:telegram:dm:123456",
          text: "hi",
        }),
      }),
    );
  });

  it("recovers telegram plugin resolution so message/send does not fail with Unknown channel: telegram", async () => {
    const telegramPlugin = {
      outbound: { deliveryMode: "direct" },
    };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(telegramPlugin)
      .mockReturnValue(telegramPlugin);

    await expect(
      sendMessage({
        cfg: { channels: { telegram: { botToken: "test-token" } } },
        channel: "telegram",
        content: "hi",
        to: "123456",
      }),
    ).resolves.toMatchObject({
      channel: "telegram",
      to: "123456",
      via: "direct",
    });

    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
  });
});
