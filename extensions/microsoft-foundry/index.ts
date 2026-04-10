import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMicrosoftFoundryProvider } from "./provider.js";

export default definePluginEntry({
  description: "Microsoft Foundry provider with Entra ID and API key auth",
  id: "microsoft-foundry",
  name: "Microsoft Foundry Provider",
  register(api) {
    api.registerProvider(buildMicrosoftFoundryProvider());
  },
});
