import { type OpenClawPluginApi, definePluginEntry } from "./api.js";
import { resolveWebhooksPluginConfig } from "./src/config.js";
import { type TaskFlowWebhookTarget, createTaskFlowWebhookRequestHandler } from "./src/http.js";

export default definePluginEntry({
  description:
    "Authenticated inbound webhooks that bind external automation to OpenClaw TaskFlows.",
  id: "webhooks",
  name: "Webhooks",
  async register(api: OpenClawPluginApi) {
    const routes = await resolveWebhooksPluginConfig({
      cfg: api.config,
      env: process.env,
      logger: api.logger,
      pluginConfig: api.pluginConfig,
    });
    if (routes.length === 0) {
      return;
    }

    const targetsByPath = new Map<string, TaskFlowWebhookTarget[]>();
    const handler = createTaskFlowWebhookRequestHandler({
      cfg: api.config,
      targetsByPath,
    });

    for (const route of routes) {
      const taskFlow = api.runtime.taskFlow.bindSession({
        sessionKey: route.sessionKey,
      });
      const target: TaskFlowWebhookTarget = {
        defaultControllerId: route.controllerId,
        path: route.path,
        routeId: route.routeId,
        secret: route.secret,
        taskFlow,
      };
      targetsByPath.set(target.path, [...(targetsByPath.get(target.path) ?? []), target]);
      api.registerHttpRoute({
        auth: "plugin",
        handler,
        match: "exact",
        path: target.path,
        replaceExisting: true,
      });
      api.logger.info?.(
        `[webhooks] registered route ${route.routeId} on ${route.path} for session ${route.sessionKey}`,
      );
    }
  },
});
