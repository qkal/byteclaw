import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  collectBrowserSecurityAuditFindings,
  createBrowserPluginService,
  createBrowserTool,
  handleBrowserGatewayRequest,
  registerBrowserCli,
  runBrowserProxyCommand,
} from "./register.runtime.js";

export const browserPluginReload = { restartPrefixes: ["browser"] };

export const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  {
    cap: "browser",
    command: "browser.proxy",
    handle: runBrowserProxyCommand,
  },
];

export const browserSecurityAuditCollectors = [collectBrowserSecurityAuditFindings];

export function registerBrowserPlugin(api: OpenClawPluginApi) {
  api.registerTool(((ctx: OpenClawPluginToolContext) =>
    createBrowserTool({
      agentSessionKey: ctx.sessionKey,
      allowHostControl: ctx.browser?.allowHostControl,
      sandboxBridgeUrl: ctx.browser?.sandboxBridgeUrl,
    })) as OpenClawPluginToolFactory);
  api.registerCli(({ program }) => registerBrowserCli(program), { commands: ["browser"] });
  api.registerGatewayMethod("browser.request", handleBrowserGatewayRequest, {
    scope: "operator.write",
  });
  api.registerService(createBrowserPluginService());
}
