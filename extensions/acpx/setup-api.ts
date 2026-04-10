import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export default definePluginEntry({
  description: "Lightweight ACPX setup hooks",
  id: "acpx",
  name: "ACPX Setup",
  register(api) {
    api.registerAutoEnableProbe(({ config }) => {
      const backendRaw = normalizeLowercaseStringOrEmpty(config.acp?.backend);
      const configured =
        config.acp?.enabled === true ||
        config.acp?.dispatch?.enabled === true ||
        backendRaw === "acpx";
      return configured && (!backendRaw || backendRaw === "acpx") ? "ACP runtime configured" : null;
    });
  },
});
