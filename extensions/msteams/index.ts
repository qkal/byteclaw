import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "Microsoft Teams channel plugin (Bot Framework)",
  id: "msteams",
  importMetaUrl: import.meta.url,
  name: "Microsoft Teams",
  plugin: {
    exportName: "msteamsPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setMSTeamsRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
