import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "IRC channel plugin",
  id: "irc",
  importMetaUrl: import.meta.url,
  name: "IRC",
  plugin: {
    exportName: "ircPlugin",
    specifier: "./channel-plugin-api.js",
  },
  runtime: {
    exportName: "setIrcRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
