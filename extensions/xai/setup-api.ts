import { definePluginEntry } from "@openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "./src/tool-config-shared.js";

export default definePluginEntry({
  description: "Lightweight xAI setup hooks",
  id: "xai",
  name: "xAI Setup",
  register(api) {
    api.registerAutoEnableProbe(({ config }) => {
      const pluginConfig = config.plugins?.entries?.xai?.config;
      const web = config.tools?.web as Record<string, unknown> | undefined;
      if (
        isRecord(web?.x_search) ||
        (isRecord(pluginConfig) &&
          (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution)))
      ) {
        return "xai tool configured";
      }
      return null;
    });
  },
});
