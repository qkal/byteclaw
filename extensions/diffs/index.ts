import { definePluginEntry } from "./api.js";
import { diffsPluginConfigSchema } from "./src/config.js";
import { registerDiffsPlugin } from "./src/plugin.js";

export default definePluginEntry({
  configSchema: diffsPluginConfigSchema,
  description: "Read-only diff viewer and PNG/PDF renderer for agents.",
  id: "diffs",
  name: "Diffs",
  register: registerDiffsPlugin,
});
