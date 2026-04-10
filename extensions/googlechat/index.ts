import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "OpenClaw Google Chat channel plugin",
  id: "googlechat",
  importMetaUrl: import.meta.url,
  name: "Google Chat",
  plugin: {
    exportName: "googlechatPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setGoogleChatRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
