import {
  type AnyAgentTool,
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";

function createZalouserTool(context?: unknown): AnyAgentTool {
  const createTool = loadBundledEntryExportSync<(context?: unknown) => AnyAgentTool>(
    import.meta.url,
    {
      exportName: "createZalouserTool",
      specifier: "./api.js",
    },
  );
  return createTool(context);
}

export default defineBundledChannelEntry({
  description: "Zalo personal account messaging via native zca-js integration",
  id: "zalouser",
  importMetaUrl: import.meta.url,
  name: "Zalo Personal",
  plugin: {
    exportName: "zalouserPlugin",
    specifier: "./api.js",
  },
  registerFull(api) {
    api.registerTool((ctx) => createZalouserTool(ctx), { name: "zalouser" });
  },
  runtime: {
    exportName: "setZalouserRuntime",
    specifier: "./runtime-api.js",
  },
});
