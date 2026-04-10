import type { Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadActivatedBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync,
}));

describe("browser bridge facade", () => {
  beforeEach(() => {
    loadActivatedBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("stays cold until a bridge function is called", async () => {
    await import("./browser-bridge.js");

    expect(loadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("delegates bridge lifecycle calls through the activated runtime facade", async () => {
    const bridge = {
      baseUrl: "http://127.0.0.1:19001",
      port: 19_001,
      server: {} as Server,
      state: {
        resolved: {
          enabled: true,
        },
      },
    };
    const startBrowserBridgeServer = vi.fn(async () => bridge);
    const stopBrowserBridgeServer = vi.fn(async () => undefined);
    loadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      startBrowserBridgeServer,
      stopBrowserBridgeServer,
    });

    const facade = await import("./browser-bridge.js");

    await expect(
      facade.startBrowserBridgeServer({
        authToken: "token",
        resolved: bridge.state.resolved as never,
      }),
    ).resolves.toEqual(bridge);
    await expect(facade.stopBrowserBridgeServer(bridge.server)).resolves.toBeUndefined();
    expect(loadActivatedBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      artifactBasename: "runtime-api.js",
      dirName: "browser",
    });
    expect(startBrowserBridgeServer).toHaveBeenCalledWith({
      authToken: "token",
      resolved: bridge.state.resolved,
    });
    expect(stopBrowserBridgeServer).toHaveBeenCalledWith(bridge.server);
  });
});
