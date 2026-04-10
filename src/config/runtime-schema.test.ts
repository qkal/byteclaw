import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRegistryVersion,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const mockLoadConfig = vi.hoisted(() => vi.fn<() => OpenClawConfig>());
const mockReadConfigFileSnapshot = vi.hoisted(() => vi.fn<() => Promise<ConfigFileSnapshot>>());
const mockLoadPluginManifestRegistry = vi.hoisted(() => vi.fn());

let readBestEffortRuntimeConfigSchema: typeof import("./runtime-schema.js").readBestEffortRuntimeConfigSchema;
let loadGatewayRuntimeConfigSchema: typeof import("./runtime-schema.js").loadGatewayRuntimeConfigSchema;

vi.mock("./config.js", () => ({
  loadConfig: () => mockLoadConfig(),
  readConfigFileSnapshot: () => mockReadConfigFileSnapshot(),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => mockLoadPluginManifestRegistry(...args),
}));

function makeSnapshot(params: { valid: boolean; config?: OpenClawConfig }): ConfigFileSnapshot {
  return {
    config: params.config ?? {},
    exists: true,
    issues: params.valid ? [] : [{ message: "invalid", path: "gateway" }],
    legacyIssues: [],
    parsed: params.config ?? {},
    path: "/tmp/openclaw.json",
    raw: "{}",
    resolved: params.config ?? {},
    runtimeConfig: params.config ?? {},
    sourceConfig: params.config ?? {},
    valid: params.valid,
    warnings: [],
  };
}

function makeManifestRegistry() {
  return {
    diagnostics: [],
    plugins: [
      {
        channels: [],
        configSchema: {
          properties: {
            mode: { type: "string" },
          },
          type: "object",
        },
        configUiHints: {},
        description: "Demo plugin",
        id: "demo",
        name: "Demo",
        origin: "bundled",
      },
      {
        channelCatalogMeta: {
          blurb: "Telegram channel",
          id: "telegram",
          label: "Telegram",
        },
        channelConfigs: {
          telegram: {
            schema: {
              properties: {
                botToken: { type: "string" },
              },
              type: "object",
            },
            uiHints: {},
          },
        },
        channels: ["telegram"],
        description: "Telegram plugin",
        id: "telegram",
        name: "Telegram",
        origin: "bundled",
      },
      {
        channelCatalogMeta: {
          blurb: "Slack channel",
          id: "slack",
          label: "Slack",
        },
        channelConfigs: {
          slack: {
            schema: {
              properties: {
                botToken: { type: "string" },
              },
              type: "object",
            },
            uiHints: {},
          },
        },
        channels: ["slack"],
        description: "Slack plugin",
        id: "slack",
        name: "Slack",
        origin: "bundled",
      },
      {
        channelCatalogMeta: {
          blurb: "Matrix channel",
          id: "matrix",
          label: "Matrix",
        },
        channelConfigs: {
          matrix: {
            schema: {
              properties: {
                homeserver: { type: "string" },
              },
              type: "object",
            },
            uiHints: {},
          },
        },
        channels: ["matrix"],
        description: "Matrix plugin",
        id: "matrix",
        name: "Matrix",
        origin: "workspace",
      },
    ],
  };
}

async function readSchemaNodes() {
  const result = await readBestEffortRuntimeConfigSchema();
  const schema = result.schema as { properties?: Record<string, unknown> };
  const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
  const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;
  const pluginsNode = schema.properties?.plugins as Record<string, unknown> | undefined;
  const pluginProps = pluginsNode?.properties as Record<string, unknown> | undefined;
  const entriesNode = pluginProps?.entries as Record<string, unknown> | undefined;
  const entryProps = entriesNode?.properties as Record<string, unknown> | undefined;
  return { channelProps, entryProps };
}

beforeAll(async () => {
  ({ readBestEffortRuntimeConfigSchema, loadGatewayRuntimeConfigSchema } =
    await import("./runtime-schema.js"));
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("readBestEffortRuntimeConfigSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({});
    mockLoadPluginManifestRegistry.mockReturnValue(makeManifestRegistry());
  });

  it("merges manifest plugin metadata for valid configs", async () => {
    mockReadConfigFileSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        config: { plugins: { entries: { demo: { enabled: true } } } },
        valid: true,
      }),
    );

    const { channelProps, entryProps } = await readSchemaNodes();

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        cache: false,
        config: { plugins: { entries: { demo: { enabled: true } } } },
      }),
    );
    expect(channelProps?.telegram).toBeTruthy();
    expect(channelProps?.matrix).toBeTruthy();
    expect(entryProps?.demo).toBeTruthy();
  });

  it("falls back to bundled channel metadata when config is invalid", async () => {
    mockReadConfigFileSnapshot.mockResolvedValueOnce(makeSnapshot({ valid: false }));

    const { channelProps, entryProps } = await readSchemaNodes();

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        cache: false,
        config: { plugins: { enabled: true } },
      }),
    );
    expect(channelProps?.telegram).toBeTruthy();
    expect(channelProps?.slack).toBeTruthy();
    expect(entryProps?.demo).toBeUndefined();
  });
});

describe("loadGatewayRuntimeConfigSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ plugins: { entries: { demo: { enabled: true } } } });
    mockLoadPluginManifestRegistry.mockReturnValue(makeManifestRegistry());
  });

  it("uses manifest metadata instead of booting plugin runtime", async () => {
    const result = loadGatewayRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        cache: false,
        config: { plugins: { entries: { demo: { enabled: true } } } },
      }),
    );
    expect(channelProps?.telegram).toBeTruthy();
    expect(channelProps?.matrix).toBeTruthy();
  });

  it("does not activate or replace the active plugin registry across repeated schema loads (regression guard for #54816)", () => {
    // Each MCP connection triggers a config.schema / config.get gateway request which calls
    // LoadGatewayRuntimeConfigSchema. The original bug caused a fresh full plugin registry to
    // Be activated on every call, re-running registerFull for all channel plugins including
    // Feishu. Verify that repeated calls keep using manifest metadata without replacing the
    // Already-active runtime registry or mutating its activation version.
    const activeRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(activeRegistry, "startup-registry");
    const versionBefore = getActivePluginRegistryVersion();

    loadGatewayRuntimeConfigSchema();
    loadGatewayRuntimeConfigSchema();
    loadGatewayRuntimeConfigSchema();

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledTimes(3);
    for (const call of mockLoadPluginManifestRegistry.mock.calls) {
      expect(call[0]).toMatchObject({ cache: false });
    }
    expect(getActivePluginRegistry()).toBe(activeRegistry);
    expect(getActivePluginRegistryKey()).toBe("startup-registry");
    expect(getActivePluginRegistryVersion()).toBe(versionBefore);
  });
});
