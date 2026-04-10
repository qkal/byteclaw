import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginAutoEnableResult } from "../../config/plugin-auto-enable.js";

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const listChannelPluginCatalogEntries = vi.hoisted(() => vi.fn((): unknown[] => []));
const listChatChannels = vi.hoisted(() => vi.fn((): Record<string, string>[] => []));
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn<(args: { config: unknown; env?: NodeJS.ProcessEnv }) => PluginAutoEnableResult>(
    ({ config }) => ({
      autoEnabledReasons: {},
      changes: [] as string[],
      config: config as never,
    }),
  ),
);

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => loadPluginManifestRegistry(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (args: unknown) =>
    applyPluginAutoEnable(args as { config: unknown; env?: NodeJS.ProcessEnv }),
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  listChannelPluginCatalogEntries: (_args?: unknown) => listChannelPluginCatalogEntries(),
}));

vi.mock("../../channels/registry.js", () => ({
  listChatChannels: () => listChatChannels(),
}));

import { listManifestInstalledChannelIds, resolveChannelSetupEntries } from "./discovery.js";

describe("listManifestInstalledChannelIds", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockReset().mockReturnValue({
      diagnostics: [],
      plugins: [],
    });
    listChannelPluginCatalogEntries.mockReset().mockReturnValue([]);
    listChatChannels.mockReset().mockReturnValue([]);
    applyPluginAutoEnable.mockReset().mockImplementation(({ config }) => ({
      autoEnabledReasons: {},
      changes: [] as string[],
      config: config as never,
    }));
  });

  it("uses the auto-enabled config snapshot for manifest discovery", () => {
    const autoEnabledConfig = {
      autoEnabled: true,
      channels: { slack: { enabled: true } },
      plugins: { allow: ["slack"] },
    } as never;
    applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
      changes: ["slack"] as string[],
      config: autoEnabledConfig,
    });
    loadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [{ channels: ["slack"], id: "slack" }],
    });

    const installedIds = listManifestInstalledChannelIds({
      cfg: {} as never,
      env: { OPENCLAW_HOME: "/tmp/home" } as NodeJS.ProcessEnv,
      workspaceDir: "/tmp/workspace",
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: { OPENCLAW_HOME: "/tmp/home" },
    });
    expect(loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: autoEnabledConfig,
      env: { OPENCLAW_HOME: "/tmp/home" },
      workspaceDir: "/tmp/workspace",
    });
    expect(installedIds).toEqual(new Set(["slack"]));
  });

  it("filters channels hidden from setup out of interactive entries", () => {
    listChatChannels.mockReturnValue([
      {
        blurb: "bot token",
        docsPath: "/channels/telegram",
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
      },
    ]);

    const resolved = resolveChannelSetupEntries({
      cfg: {} as never,
      env: { OPENCLAW_HOME: "/tmp/home" } as NodeJS.ProcessEnv,
      installedPlugins: [
        {
          id: "qa-channel",
          meta: {
            blurb: "synthetic",
            docsPath: "/channels/qa-channel",
            exposure: { setup: false },
            id: "qa-channel",
            label: "QA Channel",
            selectionLabel: "QA Channel",
          },
        } as never,
      ],
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.entries.map((entry) => entry.id)).toEqual(["telegram"]);
  });
});
