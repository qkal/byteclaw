import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "Telegram channel plugin",
  id: "telegram",
  importMetaUrl: import.meta.url,
  name: "Telegram",
  plugin: {
    exportName: "telegramPlugin",
    specifier: "./channel-plugin-api.js",
  },
  runtime: {
    exportName: "setTelegramRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
