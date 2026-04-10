import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

type DiscordSubagentHooksModule = typeof import("./subagent-hooks-api.js");

let discordSubagentHooksPromise: Promise<DiscordSubagentHooksModule> | null = null;

function loadDiscordSubagentHooksModule() {
  discordSubagentHooksPromise ??= import("./subagent-hooks-api.js");
  return discordSubagentHooksPromise;
}

export default defineBundledChannelEntry({
  description: "Discord channel plugin",
  id: "discord",
  importMetaUrl: import.meta.url,
  name: "Discord",
  plugin: {
    exportName: "discordPlugin",
    specifier: "./channel-plugin-api.js",
  },
  registerFull(api) {
    api.on("subagent_spawning", async (event) => {
      const { handleDiscordSubagentSpawning } = await loadDiscordSubagentHooksModule();
      return await handleDiscordSubagentSpawning(api, event);
    });
    api.on("subagent_ended", async (event) => {
      const { handleDiscordSubagentEnded } = await loadDiscordSubagentHooksModule();
      handleDiscordSubagentEnded(event);
    });
    api.on("subagent_delivery_target", async (event) => {
      const { handleDiscordSubagentDeliveryTarget } = await loadDiscordSubagentHooksModule();
      return handleDiscordSubagentDeliveryTarget(event);
    });
  },
  runtime: {
    exportName: "setDiscordRuntime",
    specifier: "./runtime-api.js",
  },
});
