import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "Twitch IRC chat channel plugin",
  id: "twitch",
  importMetaUrl: import.meta.url,
  name: "Twitch",
  plugin: {
    exportName: "twitchPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setTwitchRuntime",
    specifier: "./api.js",
  },
});
