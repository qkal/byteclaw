import { beforeEach, describe, expect, it, vi } from "vitest";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const routeLogsToStderrMock = vi.hoisted(() => vi.fn());
const ensureCliCommandBootstrapMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("../logging/console.js", () => ({
  routeLogsToStderr: routeLogsToStderrMock,
}));

vi.mock("./command-bootstrap.js", () => ({
  ensureCliCommandBootstrap: ensureCliCommandBootstrapMock,
}));

describe("command-execution-startup", () => {
  let mod: typeof import("./command-execution-startup.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mod = await import("./command-execution-startup.js");
  });

  it("resolves startup context from argv and mode", () => {
    expect(
      mod.resolveCliExecutionStartupContext({
        argv: ["node", "openclaw", "status", "--json"],
        jsonOutputMode: true,
        routeMode: true,
      }),
    ).toEqual({
      commandPath: ["status"],
      invocation: {
        argv: ["node", "openclaw", "status", "--json"],
        commandPath: ["status"],
        hasHelpOrVersion: false,
        isRootHelpInvocation: false,
        primary: "status",
      },
      startupPolicy: {
        hideBanner: false,
        loadPlugins: false,
        skipConfigGuard: true,
        suppressDoctorStdout: true,
      },
    });
  });

  it("routes logs to stderr and emits banner only when allowed", async () => {
    await mod.applyCliExecutionStartupPresentation({
      argv: ["node", "openclaw", "status"],
      startupPolicy: {
        hideBanner: false,
        loadPlugins: true,
        skipConfigGuard: false,
        suppressDoctorStdout: true,
      },
      version: "1.2.3",
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(emitCliBannerMock).toHaveBeenCalledWith("1.2.3", {
      argv: ["node", "openclaw", "status"],
    });

    await mod.applyCliExecutionStartupPresentation({
      showBanner: true,
      startupPolicy: {
        hideBanner: true,
        loadPlugins: true,
        skipConfigGuard: false,
        suppressDoctorStdout: false,
      },
      version: "1.2.3",
    });

    expect(emitCliBannerMock).toHaveBeenCalledTimes(1);
  });

  it("forwards startup policy into bootstrap defaults and overrides", async () => {
    const statusRuntime = {} as never;
    await mod.ensureCliExecutionBootstrap({
      commandPath: ["status"],
      runtime: statusRuntime,
      startupPolicy: {
        hideBanner: false,
        loadPlugins: false,
        skipConfigGuard: true,
        suppressDoctorStdout: true,
      },
    });

    expect(ensureCliCommandBootstrapMock).toHaveBeenCalledWith({
      allowInvalid: undefined,
      commandPath: ["status"],
      loadPlugins: false,
      runtime: statusRuntime,
      skipConfigGuard: true,
      suppressDoctorStdout: true,
    });

    const messageRuntime = {} as never;
    await mod.ensureCliExecutionBootstrap({
      allowInvalid: true,
      commandPath: ["message", "send"],
      loadPlugins: true,
      runtime: messageRuntime,
      startupPolicy: {
        hideBanner: false,
        loadPlugins: false,
        skipConfigGuard: false,
        suppressDoctorStdout: false,
      },
    });

    expect(ensureCliCommandBootstrapMock).toHaveBeenLastCalledWith({
      allowInvalid: true,
      commandPath: ["message", "send"],
      loadPlugins: true,
      runtime: messageRuntime,
      skipConfigGuard: false,
      suppressDoctorStdout: false,
    });
  });
});
