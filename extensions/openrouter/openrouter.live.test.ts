import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const LIVE_MODEL_ID =
  process.env.OPENCLAW_LIVE_OPENROUTER_PLUGIN_MODEL?.trim() || "openai/gpt-5.4-nano";
const liveEnabled = OPENROUTER_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;
const ModelRegistryCtor = ModelRegistry as unknown as {
  new (authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry;
};

const registerOpenRouterPlugin = async () =>
  registerProviderPlugin({
    id: "openrouter",
    name: "OpenRouter Provider",
    plugin,
  });

describeLive("openrouter plugin live", () => {
  it("registers an OpenRouter provider that can complete a live request", async () => {
    const { providers } = await registerOpenRouterPlugin();
    const provider = requireRegisteredProvider(providers, "openrouter");

    const resolved = provider.resolveDynamicModel?.({
      modelId: LIVE_MODEL_ID,
      modelRegistry: new ModelRegistryCtor(AuthStorage.inMemory()),
      provider: "openrouter",
    });
    if (!resolved) {
      throw new Error(`openrouter provider did not resolve ${LIVE_MODEL_ID}`);
    }

    expect(resolved).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      id: LIVE_MODEL_ID,
      provider: "openrouter",
    });

    const client = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: resolved.baseUrl,
    });
    const response = await client.chat.completions.create({
      max_tokens: 16,
      messages: [{ content: "Reply with exactly OK.", role: "user" }],
      model: resolved.id,
    });

    expect(response.choices[0]?.message?.content?.trim()).toMatch(/^OK[.!]?$/);
  }, 30_000);
});
