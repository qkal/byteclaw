import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "iMessage channel plugin",
  id: "imessage",
  importMetaUrl: import.meta.url,
  name: "iMessage",
  plugin: {
    exportName: "imessagePlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setIMessageRuntime",
    specifier: "./runtime-api.js",
  },
});
