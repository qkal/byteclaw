import {
  type OpenClawPluginApi,
  defineBundledChannelEntry,
} from "openclaw/plugin-sdk/channel-entry-contract";

type RegisteredLineCardCommand = Parameters<OpenClawPluginApi["registerCommand"]>[0];

let lineCardCommandPromise: Promise<RegisteredLineCardCommand> | null = null;

async function loadLineCardCommand(api: OpenClawPluginApi): Promise<RegisteredLineCardCommand> {
  lineCardCommandPromise ??= (async () => {
    let registered: RegisteredLineCardCommand | null = null;
    const { registerLineCardCommand } = await import("./src/card-command.js");
    registerLineCardCommand({
      ...api,
      registerCommand(command: RegisteredLineCardCommand) {
        registered = command;
      },
    });
    if (!registered) {
      throw new Error("LINE card command registration unavailable");
    }
    return registered;
  })();
  return await lineCardCommandPromise;
}

export default defineBundledChannelEntry({
  description: "LINE Messaging API channel plugin",
  id: "line",
  importMetaUrl: import.meta.url,
  name: "LINE",
  plugin: {
    exportName: "linePlugin",
    specifier: "./api.js",
  },
  registerFull(api) {
    api.registerCommand({
      acceptsArgs: true,
      description: "Send a rich card message (LINE).",
      async handler(ctx) {
        const command = await loadLineCardCommand(api);
        return await command.handler(ctx);
      },
      name: "card",
      requireAuth: false,
    });
  },
  runtime: {
    exportName: "setLineRuntime",
    specifier: "./runtime-api.js",
  },
});
