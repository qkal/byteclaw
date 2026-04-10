import type { Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiAiStreamSimpleMock } from "../../../test/helpers/agents/pi-ai-stream-simple-mock.js";
import { __testing as extraParamsTesting } from "./extra-params.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@mariozechner/pi-ai", async () =>
  createPiAiStreamSimpleMock(() =>
    vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai"),
  ),
);

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: (params) => params.context.extraParams,
    wrapProviderStreamFn: () => undefined,
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("extra-params: Google thinking payload compatibility", () => {
  it("strips negative thinking budgets and fills Gemini 3.1 thinkingLevel", () => {
    const payload = runExtraParamsCase({
      applyModelId: "gemini-3.1-pro-preview",
      applyProvider: "google",
      model: {
        api: "google-generative-ai",
        id: "gemini-3.1-pro-preview",
        provider: "google",
      } as unknown as Model<"openai-completions">,
      payload: {
        config: {
          thinkingConfig: {
            thinkingBudget: -1,
          },
        },
        contents: [],
      },
      thinkingLevel: "high",
    }).payload as {
      config?: {
        thinkingConfig?: Record<string, unknown>;
      };
    };

    expect(payload.config?.thinkingConfig?.thinkingBudget).toBeUndefined();
    expect(payload.config?.thinkingConfig?.thinkingLevel).toBe("HIGH");
  });

  it("passes cachedContent through Google extra params", () => {
    const { options } = runExtraParamsCase({
      applyModelId: "gemini-2.5-pro",
      applyProvider: "google",
      cfg: {
        agents: {
          defaults: {
            models: {
              "google/gemini-2.5-pro": {
                params: {
                  cachedContent: "cachedContents/test-cache",
                },
              },
            },
          },
        },
      } as never,
      model: {
        api: "google-generative-ai",
        id: "gemini-2.5-pro",
        provider: "google",
      } as unknown as Model<"openai-completions">,
      payload: {
        contents: [],
      },
    });

    expect((options as { cachedContent?: string } | undefined)?.cachedContent).toBe(
      "cachedContents/test-cache",
    );
  });

  it("lets higher-precedence cachedContent override lower-precedence cached_content", () => {
    const { options } = runExtraParamsCase({
      applyModelId: "gemini-2.5-pro",
      applyProvider: "google",
      cfg: {
        agents: {
          defaults: {
            models: {
              "google/gemini-2.5-pro": {
                params: {
                  cachedContent: "cachedContents/model-cache",
                },
              },
            },
            params: {
              cached_content: "cachedContents/default-cache",
            },
          },
        },
      } as never,
      model: {
        api: "google-generative-ai",
        id: "gemini-2.5-pro",
        provider: "google",
      } as unknown as Model<"openai-completions">,
      payload: {
        contents: [],
      },
    });

    expect((options as { cachedContent?: string } | undefined)?.cachedContent).toBe(
      "cachedContents/model-cache",
    );
  });
});
