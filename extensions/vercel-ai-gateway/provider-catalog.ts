import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { VERCEL_AI_GATEWAY_BASE_URL, discoverVercelAiGatewayModels } from "./models.js";

export async function buildVercelAiGatewayProvider(): Promise<ModelProviderConfig> {
  return {
    api: "anthropic-messages",
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    models: await discoverVercelAiGatewayModels(),
  };
}
