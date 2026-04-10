import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { VENICE_BASE_URL, discoverVeniceModels } from "./models.js";

export async function buildVeniceProvider(): Promise<ModelProviderConfig> {
  const models = await discoverVeniceModels();
  return {
    api: "openai-completions",
    baseUrl: VENICE_BASE_URL,
    models,
  };
}
