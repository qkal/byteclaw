import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

function registerSlashCommandRoute(api: OpenClawPluginApi): void {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    exportName: "registerSlashCommandRoute",
    specifier: "./slash-route-api.js",
  });
  register(api);
}

export default defineBundledChannelEntry({
  description: "Mattermost channel plugin",
  id: "mattermost",
  importMetaUrl: import.meta.url,
  name: "Mattermost",
  plugin: {
    exportName: "mattermostPlugin",
    specifier: "./channel-plugin-api.js",
  },
  registerFull(api) {
    // Actual slash-command registration happens after the monitor connects and
    // Knows the team id; the route itself can be wired here.
    registerSlashCommandRoute(api);
  },
  runtime: {
    exportName: "setMattermostRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
