import { describe, expect, it } from "vitest";
import {
  buildModelPickerItems,
  resolveProviderEndpointLabel,
} from "./directive-handling.model-picker.js";

describe("directive-handling.model-picker", () => {
  it("dedupes provider aliases when building picker items", () => {
    expect(
      buildModelPickerItems([
        { id: "glm-5", provider: "z.ai" },
        { id: "glm-5", provider: "z-ai" },
      ]),
    ).toEqual([{ model: "glm-5", provider: "zai" }]);
  });

  it("matches provider endpoint labels across canonical aliases", () => {
    const result = resolveProviderEndpointLabel("z-ai", {
      models: {
        providers: {
          "z.ai": {
            api: "responses",
            baseUrl: "https://api.z.ai/api/paas/v4",
          },
        },
      },
    } as never);

    expect(result).toEqual({
      api: "responses",
      endpoint: "https://api.z.ai/api/paas/v4",
    });
  });
});
