import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

const mocks = vi.hoisted(() => ({
  getActivePluginRegistry: vi.fn<typeof import("../plugins/runtime.js").getActivePluginRegistry>(),
  loadOpenClawPlugins: vi.fn<typeof import("../plugins/loader.js").loadOpenClawPlugins>(),
  resolveChannelPluginIds:
    vi.fn<typeof import("../plugins/channel-plugin-ids.js").resolveChannelPluginIds>(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("../plugins/channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  resolvePluginRuntimeLoadContext:
    vi.fn<typeof import("../plugins/runtime/load-context.js").resolvePluginRuntimeLoadContext>(),
}));

let ensurePluginRegistryLoaded: typeof import("./plugin-registry.js").ensurePluginRegistryLoaded;
let resetPluginRegistryLoadedForTests: typeof import("./plugin-registry.js").__testing.resetPluginRegistryLoadedForTests;

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: (...args: Parameters<typeof mocks.loadOpenClawPlugins>) =>
    mocks.loadOpenClawPlugins(...args),
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: (...args: Parameters<typeof mocks.getActivePluginRegistry>) =>
    mocks.getActivePluginRegistry(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveChannelPluginIds: (...args: Parameters<typeof mocks.resolveChannelPluginIds>) =>
    mocks.resolveChannelPluginIds(...args),
  resolveConfiguredChannelPluginIds: (
    ...args: Parameters<typeof mocks.resolveConfiguredChannelPluginIds>
  ) => mocks.resolveConfiguredChannelPluginIds(...args),
}));

vi.mock("../plugins/runtime/load-context.js", () => ({
  buildPluginRuntimeLoadOptions: (
    context: {
      config: unknown;
      activationSourceConfig: unknown;
      autoEnabledReasons: Readonly<Record<string, string[]>>;
      workspaceDir: string | undefined;
      env: NodeJS.ProcessEnv;
      logger: typeof logger;
    },
    overrides?: Record<string, unknown>,
  ) => ({
    activationSourceConfig: context.activationSourceConfig,
    autoEnabledReasons: context.autoEnabledReasons,
    config: context.config,
    env: context.env,
    logger: context.logger,
    workspaceDir: context.workspaceDir,
    ...overrides,
  }),
  resolvePluginRuntimeLoadContext: (
    ...args: Parameters<typeof mocks.resolvePluginRuntimeLoadContext>
  ) => mocks.resolvePluginRuntimeLoadContext(...args),
}));

describe("ensurePluginRegistryLoaded", () => {
  beforeAll(async () => {
    const mod = await import("./plugin-registry.js");
    ({ ensurePluginRegistryLoaded } = mod);
    resetPluginRegistryLoadedForTests = () => mod.__testing.resetPluginRegistryLoadedForTests();
  });

  beforeEach(() => {
    mocks.loadOpenClawPlugins.mockReset();
    mocks.getActivePluginRegistry.mockReset();
    mocks.resolveConfiguredChannelPluginIds.mockReset();
    mocks.resolveChannelPluginIds.mockReset();
    mocks.resolvePluginRuntimeLoadContext.mockReset();
    resetPluginRegistryLoadedForTests();

    mocks.getActivePluginRegistry.mockReturnValue(createEmptyPluginRegistry());
    mocks.resolvePluginRuntimeLoadContext.mockImplementation((options) => {
      const rawConfig = (options?.config ?? {}) as Record<string, unknown>;
      return {
        activationSourceConfig: (options?.activationSourceConfig ?? rawConfig) as Record<
          string,
          unknown
        >,
        autoEnabledReasons: {},
        config: rawConfig,
        env: options?.env ?? process.env,
        logger,
        rawConfig,
        workspaceDir: "/tmp/workspace",
      } as never;
    });
  });

  it("uses the resolved runtime load context for configured channel scope", () => {
    const baseConfig = {
      channels: {
        "demo-chat": {
          appToken: "demo-app-token",
          botToken: "demo-bot-token",
        },
      },
    };
    const autoEnabledConfig = {
      ...baseConfig,
      plugins: {
        entries: {
          "demo-chat": {
            enabled: true,
          },
        },
      },
    };

    mocks.resolvePluginRuntimeLoadContext.mockReturnValue({
      activationSourceConfig: baseConfig,
      autoEnabledReasons: {
        "demo-chat": ["demo-chat configured"],
      },
      config: autoEnabledConfig,
      env: process.env,
      logger,
      rawConfig: baseConfig,
      workspaceDir: "/tmp/workspace",
    } as never);
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-chat"]);

    ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expect(mocks.resolveConfiguredChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        env: process.env,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: baseConfig,
        autoEnabledReasons: {
          "demo-chat": ["demo-chat configured"],
        },
        config: autoEnabledConfig,
        onlyPluginIds: ["demo-chat"],
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("reloads when escalating from configured-channels to channels", () => {
    const config = {
      channels: { "demo-channel-a": { enabled: false } },
      plugins: { enabled: true },
    };

    mocks.resolvePluginRuntimeLoadContext.mockReturnValue({
      activationSourceConfig: config,
      autoEnabledReasons: {},
      config,
      env: process.env,
      logger,
      rawConfig: config,
      workspaceDir: "/tmp/workspace",
    } as never);
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-channel-a"]);
    mocks.resolveChannelPluginIds.mockReturnValue(["demo-channel-a", "demo-channel-b"]);

    ensurePluginRegistryLoaded({ scope: "configured-channels" });
    ensurePluginRegistryLoaded({ scope: "channels" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
    expect(mocks.loadOpenClawPlugins).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        onlyPluginIds: ["demo-channel-a"],
        throwOnLoadError: true,
      }),
    );
    expect(mocks.loadOpenClawPlugins).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        onlyPluginIds: ["demo-channel-a", "demo-channel-b"],
        throwOnLoadError: true,
      }),
    );
  });

  it("does not treat a pre-seeded partial registry as all scope", () => {
    const config = {
      channels: { "demo-channel-a": { enabled: true } },
      plugins: { enabled: true },
    };

    mocks.resolvePluginRuntimeLoadContext.mockReturnValue({
      activationSourceConfig: config,
      autoEnabledReasons: {},
      config,
      env: process.env,
      logger,
      rawConfig: config,
      workspaceDir: "/tmp/workspace",
    } as never);
    mocks.getActivePluginRegistry.mockReturnValue({
      channels: [{ plugin: { id: "demo-channel-a" } }],
      plugins: [],
      tools: [],
    } as never);

    ensurePluginRegistryLoaded({ scope: "all" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("does not treat a tools-only pre-seeded registry as channel scope", () => {
    const config = {
      channels: { "demo-channel-a": { enabled: true } },
      plugins: { enabled: true },
    };

    mocks.resolvePluginRuntimeLoadContext.mockReturnValue({
      activationSourceConfig: config,
      autoEnabledReasons: {},
      config,
      env: process.env,
      logger,
      rawConfig: config,
      workspaceDir: "/tmp/workspace",
    } as never);
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-channel-a"]);
    mocks.getActivePluginRegistry.mockReturnValue({
      channels: [],
      plugins: [],
      tools: [{ pluginId: "demo-tool" }],
    } as never);

    ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        onlyPluginIds: ["demo-channel-a"],
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("reloads when a pre-seeded channel registry is missing the configured channel plugin ids", () => {
    const config = {
      channels: {
        "demo-channel-a": {
          appToken: "demo-app-token",
          botToken: "demo-bot-token",
        },
      },
      plugins: { enabled: true },
    };

    mocks.resolvePluginRuntimeLoadContext.mockReturnValue({
      activationSourceConfig: config,
      autoEnabledReasons: {},
      config,
      env: process.env,
      logger,
      rawConfig: config,
      workspaceDir: "/tmp/workspace",
    } as never);
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-channel-a"]);
    mocks.getActivePluginRegistry.mockReturnValue({
      channels: [{ plugin: { id: "demo-channel-b" } }],
      plugins: [{ id: "demo-channel-b" }],
      tools: [],
    } as never);
    ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        onlyPluginIds: ["demo-channel-a"],
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });
});
