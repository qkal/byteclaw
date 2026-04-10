import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

function registerSlackPluginHttpRoutes(api: OpenClawPluginApi): void {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    exportName: "registerSlackPluginHttpRoutes",
    specifier: "./runtime-api.js",
  });
  register(api);
}

export default defineBundledChannelEntry({
  description: "Slack channel plugin",
  id: "slack",
  importMetaUrl: import.meta.url,
  name: "Slack",
  plugin: {
    exportName: "slackPlugin",
    specifier: "./channel-plugin-api.js",
  },
  registerFull: registerSlackPluginHttpRoutes,
  runtime: {
    exportName: "setSlackRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
