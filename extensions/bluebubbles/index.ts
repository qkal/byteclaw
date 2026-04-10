import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "BlueBubbles channel plugin (macOS app)",
  id: "bluebubbles",
  importMetaUrl: import.meta.url,
  name: "BlueBubbles",
  plugin: {
    exportName: "bluebubblesPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setBlueBubblesRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
