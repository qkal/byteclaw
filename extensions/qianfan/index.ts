import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { QIANFAN_DEFAULT_MODEL_REF, applyQianfanConfig } from "./onboard.js";
import { buildQianfanProvider } from "./provider-catalog.js";

const PROVIDER_ID = "qianfan";

export default defineSingleProviderPluginEntry({
  description: "Bundled Qianfan provider plugin",
  id: PROVIDER_ID,
  name: "Qianfan Provider",
  provider: {
    auth: [
      {
        applyConfig: (cfg) => applyQianfanConfig(cfg),
        defaultModel: QIANFAN_DEFAULT_MODEL_REF,
        envVar: "QIANFAN_API_KEY",
        flagName: "--qianfan-api-key",
        hint: "API key",
        label: "Qianfan API key",
        methodId: "api-key",
        optionKey: "qianfanApiKey",
        promptMessage: "Enter Qianfan API key",
      },
    ],
    catalog: {
      buildProvider: buildQianfanProvider,
    },
    docsPath: "/providers/qianfan",
    label: "Qianfan",
  },
});
