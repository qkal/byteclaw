import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  description: "Persistent wiki compiler and Obsidian-friendly knowledge vault for OpenClaw.",
  id: "memory-wiki",
  name: "Memory Wiki",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerWikiCli } = await import("./src/cli.js");
        registerWikiCli(program);
      },
      {
        descriptors: [
          {
            description: "Inspect and initialize the memory wiki vault",
            hasSubcommands: true,
            name: "wiki",
          },
        ],
      },
    );
  },
});
