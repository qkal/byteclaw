import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const resolveRuntimePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryVersionMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());
const isDeliverableMessageChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
  resolveDefaultAgentId: (...args: unknown[]) => resolveDefaultAgentIdMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: (...args: unknown[]) => resolveRuntimePluginRegistryMock(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginChannelRegistry: (...args: unknown[]) =>
    getActivePluginChannelRegistryMock(...args),
  getActivePluginChannelRegistryVersion: (...args: unknown[]) =>
    getActivePluginChannelRegistryVersionMock(...args),
  getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
}));

vi.mock("../../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (...args: unknown[]) => isDeliverableMessageChannelMock(...args),
  normalizeMessageChannel: (...args: unknown[]) => normalizeMessageChannelMock(...args),
}));

import { importFreshModule } from "../../../test/helpers/import-fresh.js";

async function importChannelResolution(scope: string) {
  return await importFreshModule<typeof import("./channel-resolution.js")>(
    import.meta.url,
    `./channel-resolution.js?scope=${scope}`,
  );
}

function expectBootstrapArgs() {
  expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
    expect.objectContaining({
      activationSourceConfig: { channels: {} },
      config: { autoEnabled: true },
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
      workspaceDir: "/tmp/workspace",
    }),
  );
}

describe("outbound channel resolution", () => {
  beforeEach(async () => {
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    getChannelPluginMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReset();
    getActivePluginRegistryMock.mockReset();
    getActivePluginChannelRegistryMock.mockReset();
    getActivePluginChannelRegistryVersionMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    isDeliverableMessageChannelMock.mockReset();

    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
    isDeliverableMessageChannelMock.mockImplementation((value?: string) =>
      ["telegram", "discord", "slack"].includes(String(value)),
    );
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginChannelRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginChannelRegistryVersionMock.mockReturnValue(1);
    applyPluginAutoEnableMock.mockReturnValue({
      autoEnabledReasons: {},
      config: { autoEnabled: true },
    });
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");

    const channelResolution = await importChannelResolution("reset");
    channelResolution.resetOutboundChannelResolutionStateForTest();
  });

  it.each([
    { expected: "telegram", input: " Telegram " },
    { expected: undefined, input: "unknown" },
    { expected: undefined, input: null },
  ])("normalizes deliverable outbound channel for %j", async ({ input, expected }) => {
    const channelResolution = await importChannelResolution("normalize");
    expect(channelResolution.normalizeDeliverableOutboundChannel(input)).toBe(expected);
  });

  it("returns the already-registered plugin without bootstrapping", async () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("existing-plugin");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        cfg: {} as never,
        channel: "telegram",
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("falls back to the active registry when getChannelPlugin misses", async () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    const channelResolution = await importChannelResolution("direct-registry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        cfg: {} as never,
        channel: "telegram",
      }),
    ).toBe(plugin);
  });

  it("bootstraps plugins once per registry key and returns the newly loaded plugin", async () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("bootstrap-success");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        cfg: { channels: {} } as never,
        channel: "telegram",
      }),
    ).toBe(plugin);
    expectBootstrapArgs();

    getChannelPluginMock.mockReturnValue(undefined);
    channelResolution.resolveOutboundChannelPlugin({
      cfg: { channels: {} } as never,
      channel: "telegram",
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
    expectBootstrapArgs();
  });

  it("bootstraps when the active registry has other channels but not the requested one", async () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: { id: "discord" } }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: { id: "discord" } }],
    });
    const channelResolution = await importChannelResolution("bootstrap-missing-target");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        cfg: { channels: {} } as never,
        channel: "telegram",
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("retries bootstrap after a transient load failure", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    resolveRuntimePluginRegistryMock.mockImplementationOnce(() => {
      throw new Error("transient");
    });
    const channelResolution = await importChannelResolution("bootstrap-retry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        cfg: { channels: {} } as never,
        channel: "telegram",
      }),
    ).toBeUndefined();

    channelResolution.resolveOutboundChannelPlugin({
      cfg: { channels: {} } as never,
      channel: "telegram",
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(2);
  });

  it("retries bootstrap when the pinned channel registry version changes", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    const channelResolution = await importChannelResolution("channel-version-change");

    channelResolution.resolveOutboundChannelPlugin({
      cfg: { channels: {} } as never,
      channel: "telegram",
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);

    getActivePluginChannelRegistryVersionMock.mockReturnValue(2);
    channelResolution.resolveOutboundChannelPlugin({
      cfg: { channels: {} } as never,
      channel: "telegram",
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(2);
  });
});
