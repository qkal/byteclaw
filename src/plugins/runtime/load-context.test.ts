import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn<typeof import("../../config/config.js").loadConfig>();
const applyPluginAutoEnableMock =
  vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>();
const resolveAgentWorkspaceDirMock = vi.fn<
  typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir
>(() => "/resolved-workspace");
const resolveDefaultAgentIdMock = vi.fn<
  typeof import("../../agents/agent-scope.js").resolveDefaultAgentId
>(() => "default");

let resolvePluginRuntimeLoadContext: typeof import("./load-context.js").resolvePluginRuntimeLoadContext;
let buildPluginRuntimeLoadOptions: typeof import("./load-context.js").buildPluginRuntimeLoadOptions;

vi.mock("../../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

describe("resolvePluginRuntimeLoadContext", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ resolvePluginRuntimeLoadContext, buildPluginRuntimeLoadOptions } =
      await import("./load-context.js"));
    loadConfigMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveAgentWorkspaceDirMock.mockClear();
    resolveDefaultAgentIdMock.mockClear();

    loadConfigMock.mockReturnValue({ plugins: {} });
    applyPluginAutoEnableMock.mockImplementation((params) => ({
      autoEnabledReasons: {},
      changes: [],
      config: params.config ?? {},
    }));
  });

  it("builds the runtime plugin load context from the auto-enabled config", () => {
    const rawConfig = { plugins: {} };
    const resolvedConfig = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    applyPluginAutoEnableMock.mockReturnValue({
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
      changes: [],
      config: resolvedConfig,
    });

    const context = resolvePluginRuntimeLoadContext({
      config: rawConfig,
      env,
    });

    expect(context).toEqual(
      expect.objectContaining({
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          demo: ["demo configured"],
        },
        config: resolvedConfig,
        env,
        rawConfig,
        workspaceDir: "/resolved-workspace",
      }),
    );
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: rawConfig,
      env,
    });
    expect(resolveDefaultAgentIdMock).toHaveBeenCalledWith(resolvedConfig);
    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith(resolvedConfig, "default");
  });

  it("builds plugin load options from the shared runtime context", () => {
    const context = resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      workspaceDir: "/explicit-workspace",
    });

    expect(
      buildPluginRuntimeLoadOptions(context, {
        activate: false,
        cache: false,
        onlyPluginIds: ["demo"],
      }),
    ).toEqual(
      expect.objectContaining({
        activate: false,
        activationSourceConfig: context.activationSourceConfig,
        autoEnabledReasons: context.autoEnabledReasons,
        cache: false,
        config: context.config,
        env: context.env,
        logger: context.logger,
        onlyPluginIds: ["demo"],
        workspaceDir: "/explicit-workspace",
      }),
    );
  });
});
