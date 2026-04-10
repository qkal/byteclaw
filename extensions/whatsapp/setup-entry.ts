import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    exportName: "whatsappSetupPlugin",
    specifier: "./setup-plugin-api.js",
  },
});
