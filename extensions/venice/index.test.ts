import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("venice provider plugin", () => {
  it("applies the shared xAI compat patch to Grok-backed Venice models only", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.normalizeResolvedModel?.({
        model: {
          compat: {
            supportsUsageInStreaming: true,
          },
          id: "grok-4",
        },
        modelId: "venice/grok-4",
      } as never),
    ).toMatchObject({
      compat: {
        nativeWebSearchTool: true,
        supportsUsageInStreaming: true,
        toolCallArgumentsEncoding: "html-entities",
        toolSchemaProfile: "xai",
      },
    });

    expect(
      provider.normalizeResolvedModel?.({
        model: {
          compat: {},
          id: "llama-3.3-70b",
        },
        modelId: "venice/llama-3.3-70b",
      } as never),
    ).toBeUndefined();
  });
});
