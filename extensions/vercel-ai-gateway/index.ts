import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF, applyVercelAiGatewayConfig } from "./onboard.js";
import { buildVercelAiGatewayProvider } from "./provider-catalog.js";

const PROVIDER_ID = "vercel-ai-gateway";

export default defineSingleProviderPluginEntry({
  description: "Bundled Vercel AI Gateway provider plugin",
  id: PROVIDER_ID,
  name: "Vercel AI Gateway Provider",
  provider: {
    auth: [
      {
        applyConfig: (cfg) => applyVercelAiGatewayConfig(cfg),
        defaultModel: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
        envVar: "AI_GATEWAY_API_KEY",
        flagName: "--ai-gateway-api-key",
        hint: "API key",
        label: "Vercel AI Gateway API key",
        methodId: "api-key",
        optionKey: "aiGatewayApiKey",
        promptMessage: "Enter Vercel AI Gateway API key",
        wizard: {
          choiceId: "ai-gateway-api-key",
          groupId: "ai-gateway",
        },
      },
    ],
    catalog: {
      buildProvider: buildVercelAiGatewayProvider,
    },
    docsPath: "/providers/vercel-ai-gateway",
    label: "Vercel AI Gateway",
  },
});
