import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  buildChannelAccountSnapshot: vi.fn(),
  buildChannelUiCatalog: vi.fn(),
  getChannelActivity: vi.fn(),
  listChannelPlugins: vi.fn(),
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: vi.fn(async () => ({
    config: {},
    path: "openclaw.config.json",
    raw: "{}",
  })),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(),
  listChannelPlugins: mocks.listChannelPlugins,
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  buildChannelUiCatalog: mocks.buildChannelUiCatalog,
}));

vi.mock("../../channels/plugins/status.js", () => ({
  buildChannelAccountSnapshot: mocks.buildChannelAccountSnapshot,
}));

vi.mock("../../infra/channel-activity.js", () => ({
  getChannelActivity: mocks.getChannelActivity,
}));

import { channelsHandlers } from "./channels.js";

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    client: null,
    context: {
      getRuntimeSnapshot: () => ({
        channelAccounts: {},
        channels: {},
      }),
    },
    isWebchatConnect: () => false,
    params,
    req: { id: "req-1", method: "channels.status", params, type: "req" },
    respond: vi.fn(),
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("channelsHandlers channels.status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ changes: [], config }));
    mocks.buildChannelUiCatalog.mockReturnValue({
      detailLabels: { whatsapp: "WhatsApp" },
      entries: { whatsapp: { id: "whatsapp" } },
      labels: { whatsapp: "WhatsApp" },
      order: ["whatsapp"],
      systemImages: { whatsapp: undefined },
    });
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    mocks.getChannelActivity.mockReturnValue({
      inboundAt: null,
      outboundAt: null,
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        config: {
          isConfigured: async (_account: unknown, cfg: { autoEnabled?: boolean }) =>
            Boolean(cfg.autoEnabled),
          isEnabled: () => true,
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        id: "whatsapp",
      },
    ]);
  });

  it("uses the auto-enabled config snapshot for channel account state", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    mocks.applyPluginAutoEnable.mockReturnValue({ changes: [], config: autoEnabledConfig });
    const respond = vi.fn();
    const opts = createOptions(
      { probe: false, timeoutMs: 2000 },
      {
        respond,
      },
    );

    await channelsHandlers["channels.status"](opts);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(mocks.buildChannelAccountSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        cfg: autoEnabledConfig,
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        channels: {
          whatsapp: expect.objectContaining({
            configured: true,
          }),
        },
      }),
      undefined,
    );
  });
});
