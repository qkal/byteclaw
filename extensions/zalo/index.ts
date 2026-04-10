import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "Zalo channel plugin",
  id: "zalo",
  importMetaUrl: import.meta.url,
  name: "Zalo",
  plugin: {
    exportName: "zaloPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setZaloRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
