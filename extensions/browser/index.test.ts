import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import {
  browserPluginNodeHostCommands,
  browserPluginReload,
  browserSecurityAuditCollectors,
  registerBrowserPlugin,
} from "./plugin-registration.js";
import type { OpenClawPluginApi } from "./runtime-api.js";

const runtimeApiMocks = vi.hoisted(() => ({
  createBrowserPluginService: vi.fn(() => ({ id: "browser-control", start: vi.fn() })),
  createBrowserTool: vi.fn(() => ({
    description: "browser",
    execute: vi.fn(),
    name: "browser",
    parameters: { properties: {}, type: "object" },
  })),
  handleBrowserGatewayRequest: vi.fn(),
  registerBrowserCli: vi.fn(),
}));

vi.mock("./register.runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("./register.runtime.js")>("./register.runtime.js");
  return {
    ...actual,
    createBrowserPluginService: runtimeApiMocks.createBrowserPluginService,
    createBrowserTool: runtimeApiMocks.createBrowserTool,
    handleBrowserGatewayRequest: runtimeApiMocks.handleBrowserGatewayRequest,
    registerBrowserCli: runtimeApiMocks.registerBrowserCli,
  };
});

function createApi() {
  const registerCli = vi.fn();
  const registerGatewayMethod = vi.fn();
  const registerService = vi.fn();
  const registerTool = vi.fn();
  const api = createTestPluginApi({
    config: {},
    id: "browser",
    name: "Browser",
    registerCli,
    registerGatewayMethod,
    registerService,
    registerTool,
    runtime: {} as OpenClawPluginApi["runtime"],
    source: "test",
  });
  return { api, registerCli, registerGatewayMethod, registerService, registerTool };
}

describe("browser plugin", () => {
  it("exposes static browser metadata on the plugin definition", () => {
    expect(browserPluginReload).toEqual({ restartPrefixes: ["browser"] });
    expect(browserPluginNodeHostCommands).toEqual([
      expect.objectContaining({
        cap: "browser",
        command: "browser.proxy",
      }),
    ]);
    expect(browserSecurityAuditCollectors).toHaveLength(1);
  });

  it("forwards per-session browser options into the tool factory", async () => {
    const { api, registerTool } = createApi();
    await registerBrowserPlugin(api);

    const tool = registerTool.mock.calls[0]?.[0];
    if (typeof tool !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }

    tool({
      browser: {
        allowHostControl: true,
        sandboxBridgeUrl: "http://127.0.0.1:9999",
      },
      sessionKey: "agent:main:webchat:direct:123",
    });

    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:webchat:direct:123",
      allowHostControl: true,
      sandboxBridgeUrl: "http://127.0.0.1:9999",
    });
  });
});
