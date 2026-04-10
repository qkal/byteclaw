import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCliPluginRegistryLoadedMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("./plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: ensureCliPluginRegistryLoadedMock,
  resolvePluginRegistryScopeForCommandPath: vi.fn((commandPath: string[]) =>
    commandPath[0] === "status" || commandPath[0] === "health" ? "channels" : "all",
  ),
}));

describe("ensureCliCommandBootstrap", () => {
  let ensureCliCommandBootstrap: typeof import("./command-bootstrap.js").ensureCliCommandBootstrap;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ ensureCliCommandBootstrap } = await import("./command-bootstrap.js"));
  });

  it("runs config guard and plugin loading with shared options", async () => {
    const runtime = {} as never;

    await ensureCliCommandBootstrap({
      allowInvalid: true,
      commandPath: ["agents", "list"],
      loadPlugins: true,
      runtime,
      suppressDoctorStdout: true,
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      allowInvalid: true,
      commandPath: ["agents", "list"],
      runtime,
      suppressDoctorStdout: true,
    });
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      routeLogsToStderr: true,
      scope: "all",
    });
  });

  it("skips config guard without skipping plugin loading", async () => {
    await ensureCliCommandBootstrap({
      commandPath: ["status"],
      loadPlugins: true,
      runtime: {} as never,
      skipConfigGuard: true,
      suppressDoctorStdout: true,
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      routeLogsToStderr: true,
      scope: "channels",
    });
  });

  it("does nothing extra when plugin loading is disabled", async () => {
    await ensureCliCommandBootstrap({
      commandPath: ["config", "validate"],
      loadPlugins: false,
      runtime: {} as never,
      skipConfigGuard: true,
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensureCliPluginRegistryLoadedMock).not.toHaveBeenCalled();
  });
});
