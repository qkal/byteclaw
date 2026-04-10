import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "Signal channel plugin",
  id: "signal",
  importMetaUrl: import.meta.url,
  name: "Signal",
  plugin: {
    exportName: "signalPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setSignalRuntime",
    specifier: "./runtime-api.js",
  },
});
