import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  description: "LanceDB-backed memory provider",
  id: "memory-lancedb",
  name: "Memory LanceDB",
  register(api) {
    api.registerCli(() => {}, { commands: ["ltm"] });
  },
});
