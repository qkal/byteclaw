import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "Feishu/Lark channel plugin",
  id: "feishu",
  importMetaUrl: import.meta.url,
  name: "Feishu",
  plugin: {
    exportName: "feishuPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setFeishuRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
