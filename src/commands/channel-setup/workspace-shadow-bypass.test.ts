/**
 * Regression tests for GHSA-2qrv-rc5x-2g2h incomplete-fix bypass.
 *
 * The original fix added trusted fallback behavior to two call sites in
 * channel-plugin-resolution.ts. Three other setup-flow call sites were
 * missed. These tests verify setup discovery falls back from untrusted
 * workspace shadows without hiding trusted workspace plugins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted to module top level)
// ---------------------------------------------------------------------------

const listChannelPluginCatalogEntries = vi.hoisted(() => vi.fn((_opts?: unknown): unknown[] => []));
const listChatChannels = vi.hoisted(() => vi.fn((): unknown[] => []));
const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn(({ config }: { config: unknown }) => ({
    autoEnabledReasons: {},
    changes: [] as string[],
    config: config as never,
  })),
);
const getChannelPluginCatalogEntry = vi.hoisted(() => vi.fn());

vi.mock("../../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: (...args: unknown[]) =>
    getChannelPluginCatalogEntry(...(args as [string, Record<string, unknown>])),
  listChannelPluginCatalogEntries: (opts?: unknown) => listChannelPluginCatalogEntries(opts),
}));
vi.mock("../../channels/registry.js", () => ({
  listChatChannels: () => listChatChannels(),
}));
vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...a: unknown[]) => loadPluginManifestRegistry(...a),
}));
vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (a: unknown) => applyPluginAutoEnable(a as { config: unknown }),
}));
vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: vi.fn(),
}));

import { resolveChannelSetupEntries } from "./discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  loadPluginManifestRegistry.mockReturnValue({ diagnostics: [], plugins: [] });
  listChatChannels.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Regression: resolveChannelSetupEntries (discovery.ts)
// ---------------------------------------------------------------------------

describe("resolveChannelSetupEntries workspace shadow exclusion (GHSA-2qrv-rc5x-2g2h)", () => {
  it("falls back to the bundled entry for untrusted workspace shadows", () => {
    const workspaceEntry = {
      id: "telegram",
      install: { npmSpec: "evil-telegram-shadow" },
      meta: {
        blurb: "t",
        docsPath: "/",
        id: "telegram",
        label: "Telegram",
        order: 1,
        selectionLabel: "Telegram",
      },
      origin: "workspace",
      pluginId: "evil-telegram-shadow",
    };
    const bundledEntry = {
      id: "telegram",
      install: { npmSpec: "@openclaw/telegram" },
      meta: workspaceEntry.meta,
      origin: "bundled",
      pluginId: "@openclaw/telegram",
    };
    listChannelPluginCatalogEntries.mockImplementation((opts?: unknown) =>
      (opts as { excludeWorkspace?: boolean } | undefined)?.excludeWorkspace
        ? [bundledEntry]
        : [workspaceEntry],
    );

    resolveChannelSetupEntries({
      cfg: {} as never,
      env: process.env,
      installedPlugins: [],
    });

    const fallbackCall = listChannelPluginCatalogEntries.mock.calls.find(
      ([opts]) => (opts as { excludeWorkspace?: boolean } | undefined)?.excludeWorkspace === true,
    );
    expect(fallbackCall).toBeTruthy();
  });

  it("still returns bundled-origin entries", () => {
    const bundledEntry = {
      id: "telegram",
      install: { npmSpec: "@openclaw/telegram" },
      meta: {
        blurb: "t",
        docsPath: "/",
        id: "telegram",
        label: "Telegram",
        order: 1,
        selectionLabel: "Telegram",
      },
      origin: "bundled",
      pluginId: "@openclaw/telegram",
    };
    listChannelPluginCatalogEntries.mockReturnValue([bundledEntry]);

    const result = resolveChannelSetupEntries({
      cfg: {} as never,
      env: process.env,
      installedPlugins: [],
    });

    const allIds = [
      ...result.installedCatalogEntries.map((e: { id: string }) => e.id),
      ...result.installableCatalogEntries.map((e: { id: string }) => e.id),
    ];
    expect(allIds).toContain("telegram");
  });

  it("keeps trusted workspace channel plugins visible in setup", () => {
    const workspaceEntry = {
      id: "telegram",
      install: { npmSpec: "trusted-telegram-shadow" },
      meta: {
        blurb: "t",
        docsPath: "/",
        id: "telegram",
        label: "Telegram",
        order: 1,
        selectionLabel: "Telegram",
      },
      origin: "workspace",
      pluginId: "trusted-telegram-shadow",
    };
    listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    loadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [{ channels: ["telegram"], id: "trusted-telegram-shadow" }],
    });

    const result = resolveChannelSetupEntries({
      cfg: {
        plugins: {
          allow: ["trusted-telegram-shadow"],
          enabled: true,
        },
      } as never,
      env: process.env,
      installedPlugins: [],
    });

    expect(
      result.installedCatalogEntries.map((entry: { pluginId?: string }) => entry.pluginId),
    ).toEqual(["trusted-telegram-shadow"]);
  });

  it("treats auto-enabled workspace channel plugins as trusted during setup discovery", () => {
    const workspaceEntry = {
      id: "telegram",
      install: { npmSpec: "trusted-telegram-shadow" },
      meta: {
        blurb: "t",
        docsPath: "/",
        id: "telegram",
        label: "Telegram",
        order: 1,
        selectionLabel: "Telegram",
      },
      origin: "workspace",
      pluginId: "trusted-telegram-shadow",
    };
    listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    applyPluginAutoEnable.mockImplementation(({ config }: { config: unknown }) => ({
      autoEnabledReasons: {
        "trusted-telegram-shadow": ["channel configured"],
      },
      changes: ["trusted-telegram-shadow"] as string[],
      config: {
        ...(config as Record<string, unknown>),
        plugins: {
          allow: ["trusted-telegram-shadow"],
          enabled: true,
        },
      } as never,
    }));
    loadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [{ channels: ["telegram"], id: "trusted-telegram-shadow" }],
    });

    const result = resolveChannelSetupEntries({
      cfg: {
        channels: {
          telegram: { token: "existing-token" },
        },
      } as never,
      env: process.env,
      installedPlugins: [],
    });

    expect(
      result.installedCatalogEntries.map((entry: { pluginId?: string }) => entry.pluginId),
    ).toEqual(["trusted-telegram-shadow"]);
  });

  it("keeps workspace-only install candidates visible until the user trusts them", () => {
    const workspaceEntry = {
      id: "my-cool-plugin",
      install: { npmSpec: "my-cool-plugin" },
      meta: {
        blurb: "t",
        docsPath: "/",
        id: "my-cool-plugin",
        label: "My Cool Plugin",
        order: 1,
        selectionLabel: "My Cool Plugin",
      },
      origin: "workspace",
      pluginId: "my-cool-plugin",
    };
    listChannelPluginCatalogEntries.mockImplementation((opts?: unknown) =>
      (opts as { excludeWorkspace?: boolean } | undefined)?.excludeWorkspace
        ? []
        : [workspaceEntry],
    );

    const result = resolveChannelSetupEntries({
      cfg: {} as never,
      env: process.env,
      installedPlugins: [],
    });

    expect(
      result.installableCatalogEntries.map((entry: { pluginId?: string }) => entry.pluginId),
    ).toEqual(["my-cool-plugin"]);
  });

  it("does not surface untrusted workspace-only entries as installed", () => {
    const workspaceEntry = {
      id: "my-cool-plugin",
      install: { npmSpec: "my-cool-plugin" },
      meta: {
        blurb: "t",
        docsPath: "/",
        id: "my-cool-plugin",
        label: "My Cool Plugin",
        order: 1,
        selectionLabel: "My Cool Plugin",
      },
      origin: "workspace",
      pluginId: "my-cool-plugin",
    };
    listChannelPluginCatalogEntries.mockImplementation((opts?: unknown) =>
      (opts as { excludeWorkspace?: boolean } | undefined)?.excludeWorkspace
        ? []
        : [workspaceEntry],
    );
    applyPluginAutoEnable.mockImplementation(({ config }: { config: unknown }) => ({
      autoEnabledReasons: {},
      changes: [] as string[],
      config: {
        ...(config as Record<string, unknown>),
        plugins: {},
      } as never,
    }));
    loadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [{ channels: ["my-cool-plugin"], id: "my-cool-plugin" }],
    });

    const result = resolveChannelSetupEntries({
      cfg: {
        channels: {
          "my-cool-plugin": { token: "existing-token" },
        },
      } as never,
      env: process.env,
      installedPlugins: [],
    });

    expect(result.installedCatalogEntries).toEqual([]);
    expect(result.installableCatalogEntries).toEqual([]);
  });
});
