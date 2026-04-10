import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "Synthetic QA channel plugin",
  id: "qa-channel",
  importMetaUrl: import.meta.url,
  name: "QA Channel",
  plugin: {
    exportName: "qaChannelPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setQaChannelRuntime",
    specifier: "./runtime-api.js",
  },
});
