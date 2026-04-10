import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "Native Synology Chat channel plugin for OpenClaw",
  id: "synology-chat",
  importMetaUrl: import.meta.url,
  name: "Synology Chat",
  plugin: {
    exportName: "synologyChatPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setSynologyRuntime",
    specifier: "./api.js",
  },
});
