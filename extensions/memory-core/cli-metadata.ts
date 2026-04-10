import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  description: "File-backed memory search tools and CLI",
  id: "memory-core",
  name: "Memory (Core)",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerMemoryCli } = await import("./src/cli.js");
        registerMemoryCli(program);
      },
      {
        descriptors: [
          {
            description: "Search, inspect, and reindex memory files",
            hasSubcommands: true,
            name: "memory",
          },
        ],
      },
    );
  },
});
