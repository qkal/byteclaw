import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "Nextcloud Talk channel plugin",
  id: "nextcloud-talk",
  importMetaUrl: import.meta.url,
  name: "Nextcloud Talk",
  plugin: {
    exportName: "nextcloudTalkPlugin",
    specifier: "./api.js",
  },
  runtime: {
    exportName: "setNextcloudTalkRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
