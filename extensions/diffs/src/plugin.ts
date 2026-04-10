import path from "node:path";
import { type OpenClawPluginApi, resolvePreferredOpenClawTmpDir } from "../api.js";
import {
  resolveDiffsPluginDefaults,
  resolveDiffsPluginSecurity,
  resolveDiffsPluginViewerBaseUrl,
} from "./config.js";
import { createDiffsHttpHandler } from "./http.js";
import { DIFFS_AGENT_GUIDANCE } from "./prompt-guidance.js";
import { DiffArtifactStore } from "./store.js";
import { createDiffsTool } from "./tool.js";

export function registerDiffsPlugin(api: OpenClawPluginApi): void {
  const defaults = resolveDiffsPluginDefaults(api.pluginConfig);
  const security = resolveDiffsPluginSecurity(api.pluginConfig);
  const viewerBaseUrl = resolveDiffsPluginViewerBaseUrl(api.pluginConfig);
  const store = new DiffArtifactStore({
    logger: api.logger,
    rootDir: path.join(resolvePreferredOpenClawTmpDir(), "openclaw-diffs"),
  });

  api.registerTool(
    (ctx) => createDiffsTool({ api, context: ctx, defaults, store, viewerBaseUrl }),
    {
      name: "diffs",
    },
  );
  api.registerHttpRoute({
    auth: "plugin",
    handler: createDiffsHttpHandler({
      allowRealIpFallback: api.config.gateway?.allowRealIpFallback === true,
      allowRemoteViewer: security.allowRemoteViewer,
      logger: api.logger,
      store,
      trustedProxies: api.config.gateway?.trustedProxies,
    }),
    match: "prefix",
    path: "/plugins/diffs",
  });
  api.on("before_prompt_build", async () => ({
    prependSystemContext: DIFFS_AGENT_GUIDANCE,
  }));
}
