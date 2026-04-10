import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildNvidiaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";

export default defineSingleProviderPluginEntry({
  description: "Bundled NVIDIA provider plugin",
  id: PROVIDER_ID,
  name: "NVIDIA Provider",
  provider: {
    auth: [],
    catalog: {
      buildProvider: buildNvidiaProvider,
    },
    docsPath: "/providers/nvidia",
    envVars: ["NVIDIA_API_KEY"],
    label: "NVIDIA",
  },
});
