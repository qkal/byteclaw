import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";

const mocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(() => ({}) as never),
  ensureChannelSetupPluginInstalled: vi.fn(),
  getChannelPlugin: vi.fn(),
  getChannelPluginCatalogEntry: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultAgentId: vi.fn(() => "default"),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: mocks.getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: unknown) => (typeof value === "string" ? value.trim() || null : null),
}));

vi.mock("./plugin-install.js", () => ({
  ensureChannelSetupPluginInstalled: mocks.ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel:
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

import { resolveInstallableChannelPlugin } from "./channel-plugin-resolution.js";

function createCatalogEntry(params: {
  id: string;
  pluginId: string;
  origin?: "workspace" | "bundled";
}): ChannelPluginCatalogEntry {
  return {
    id: params.id,
    install: {
      npmSpec: params.pluginId,
    },
    meta: {
      blurb: "Telegram channel",
      docsPath: "/channels/telegram",
      id: params.id,
      label: "Telegram",
      selectionLabel: "Telegram",
    },
    origin: params.origin,
    pluginId: params.pluginId,
  };
}

function createPlugin(id: string): ChannelPlugin {
  return { id } as ChannelPlugin;
}

describe("resolveInstallableChannelPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValue({
      cfg: {},
      installed: false,
    });
  });

  it("ignores untrusted workspace channel shadows during setup resolution", async () => {
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      origin: "workspace",
      pluginId: "evil-telegram-shadow",
    });
    const bundledEntry = createCatalogEntry({
      id: "telegram",
      origin: "bundled",
      pluginId: "telegram",
    });
    const bundledPlugin = createPlugin("telegram");

    mocks.listChannelPluginCatalogEntries.mockImplementation(
      ({ excludeWorkspace }: { excludeWorkspace?: boolean }) =>
        excludeWorkspace ? [bundledEntry] : [workspaceEntry],
    );
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
      ({ pluginId }: { pluginId?: string }) => ({
        channelSetups: [],
        channels: pluginId === "telegram" ? [{ plugin: bundledPlugin }] : [],
      }),
    );

    const result = await resolveInstallableChannelPlugin({
      allowInstall: false,
      cfg: { plugins: { enabled: true } },
      rawChannel: "telegram",
      runtime: {} as never,
    });

    expect(result.catalogEntry?.pluginId).toBe("telegram");
    expect(result.plugin?.id).toBe("telegram");
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        pluginId: "telegram",
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("keeps trusted workspace channel plugins eligible for setup resolution", async () => {
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      origin: "workspace",
      pluginId: "evil-telegram-shadow",
    });
    const workspacePlugin = createPlugin("telegram");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
      ({ pluginId }: { pluginId?: string }) => ({
        channelSetups: [],
        channels: pluginId === "evil-telegram-shadow" ? [{ plugin: workspacePlugin }] : [],
      }),
    );

    const result = await resolveInstallableChannelPlugin({
      allowInstall: false,
      cfg: {
        plugins: {
          allow: ["evil-telegram-shadow"],
          enabled: true,
        },
      },
      rawChannel: "telegram",
      runtime: {} as never,
    });

    expect(result.catalogEntry?.pluginId).toBe("evil-telegram-shadow");
    expect(result.plugin?.id).toBe("telegram");
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        pluginId: "evil-telegram-shadow",
        workspaceDir: "/tmp/workspace",
      }),
    );
  });
});
