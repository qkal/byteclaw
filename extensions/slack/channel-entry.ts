import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "Slack channel plugin",
  id: "slack",
  importMetaUrl: import.meta.url,
  name: "Slack",
  plugin: {
    exportName: "slackPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setSlackRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
