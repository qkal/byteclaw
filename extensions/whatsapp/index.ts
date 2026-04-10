import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  description: "WhatsApp channel plugin",
  id: "whatsapp",
  importMetaUrl: import.meta.url,
  name: "WhatsApp",
  plugin: {
    exportName: "whatsappPlugin",
    specifier: "./channel-plugin-api.js",
  },
  runtime: {
    exportName: "setWhatsAppRuntime",
    specifier: "./runtime-api.js",
  },
});
