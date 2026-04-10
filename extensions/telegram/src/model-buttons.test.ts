import { describe, expect, it } from "vitest";
import {
  type ProviderInfo,
  buildBrowseProvidersButton,
  buildModelSelectionCallbackData,
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
} from "./model-buttons.js";

describe("parseModelCallbackData", () => {
  it("parses supported callback variants", () => {
    const cases = [
      ["mdl_prov", { type: "providers" }],
      ["mdl_back", { type: "back" }],
      ["mdl_list_anthropic_2", { page: 2, provider: "anthropic", type: "list" }],
      ["mdl_list_open-ai_1", { page: 1, provider: "open-ai", type: "list" }],
      [
        "mdl_sel_anthropic/claude-sonnet-4-5",
        { model: "claude-sonnet-4-5", provider: "anthropic", type: "select" },
      ],
      ["mdl_sel_openai/gpt-4/turbo", { model: "gpt-4/turbo", provider: "openai", type: "select" }],
      [
        "mdl_sel/us.anthropic.claude-3-5-sonnet-20240620-v1:0",
        { model: "us.anthropic.claude-3-5-sonnet-20240620-v1:0", type: "select" },
      ],
      [
        "mdl_sel/anthropic/claude-3-7-sonnet",
        { model: "anthropic/claude-3-7-sonnet", type: "select" },
      ],
      ["  mdl_prov  ", { type: "providers" }],
    ] as const;
    for (const [input, expected] of cases) {
      expect(parseModelCallbackData(input), input).toEqual(expected);
    }
  });

  it("returns null for unsupported callback variants", () => {
    const invalid = [
      "commands_page_1",
      "other_callback",
      "",
      "mdl_invalid",
      "mdl_list_",
      "mdl_sel_noslash",
      "mdl_sel/",
    ];
    for (const input of invalid) {
      expect(parseModelCallbackData(input), input).toBeNull();
    }
  });
});

describe("resolveModelSelection", () => {
  it("returns explicit provider selections unchanged", () => {
    const result = resolveModelSelection({
      byProvider: new Map([
        ["openai", new Set(["gpt-4.1"])],
        ["anthropic", new Set(["claude-sonnet-4-5"])],
      ]),
      callback: { model: "gpt-4.1", provider: "openai", type: "select" },
      providers: ["openai", "anthropic"],
    });
    expect(result).toEqual({ kind: "resolved", model: "gpt-4.1", provider: "openai" });
  });

  it("resolves compact callbacks when exactly one provider matches", () => {
    const result = resolveModelSelection({
      byProvider: new Map([
        ["openai", new Set(["shared"])],
        ["anthropic", new Set(["other"])],
      ]),
      callback: { model: "shared", type: "select" },
      providers: ["openai", "anthropic"],
    });
    expect(result).toEqual({ kind: "resolved", model: "shared", provider: "openai" });
  });

  it("returns ambiguous result when zero or multiple providers match", () => {
    const sharedByBoth = resolveModelSelection({
      byProvider: new Map([
        ["openai", new Set(["shared"])],
        ["anthropic", new Set(["shared"])],
      ]),
      callback: { model: "shared", type: "select" },
      providers: ["openai", "anthropic"],
    });
    expect(sharedByBoth).toEqual({
      kind: "ambiguous",
      matchingProviders: ["openai", "anthropic"],
      model: "shared",
    });

    const missingEverywhere = resolveModelSelection({
      byProvider: new Map([
        ["openai", new Set(["gpt-4.1"])],
        ["anthropic", new Set(["claude-sonnet-4-5"])],
      ]),
      callback: { model: "missing", type: "select" },
      providers: ["openai", "anthropic"],
    });
    expect(missingEverywhere).toEqual({
      kind: "ambiguous",
      matchingProviders: [],
      model: "missing",
    });
  });
});

describe("buildModelSelectionCallbackData", () => {
  it("uses standard callback when under limit and compact callback when needed", () => {
    expect(buildModelSelectionCallbackData({ model: "gpt-4.1", provider: "openai" })).toBe(
      "mdl_sel_openai/gpt-4.1",
    );
    const longModel = "us.anthropic.claude-3-5-sonnet-20240620-v1:0";
    expect(buildModelSelectionCallbackData({ model: longModel, provider: "amazon-bedrock" })).toBe(
      `mdl_sel/${longModel}`,
    );
  });

  it("returns null when even compact callback exceeds Telegram limit", () => {
    const tooLongModel = "x".repeat(80);
    expect(buildModelSelectionCallbackData({ model: tooLongModel, provider: "openai" })).toBeNull();
  });
});

describe("buildProviderKeyboard", () => {
  it("lays out providers in two-column rows", () => {
    const cases = [
      {
        expected: [],
        input: [],
        name: "empty input",
      },
      {
        expected: [[{ callback_data: "mdl_list_anthropic_1", text: "anthropic (5)" }]],
        input: [{ count: 5, id: "anthropic" }],
        name: "single provider",
      },
      {
        expected: [
          [
            { callback_data: "mdl_list_anthropic_1", text: "anthropic (5)" },
            { callback_data: "mdl_list_openai_1", text: "openai (8)" },
          ],
        ],
        input: [
          { count: 5, id: "anthropic" },
          { count: 8, id: "openai" },
        ],
        name: "exactly one full row",
      },
      {
        expected: [
          [
            { callback_data: "mdl_list_anthropic_1", text: "anthropic (5)" },
            { callback_data: "mdl_list_openai_1", text: "openai (8)" },
          ],
          [{ callback_data: "mdl_list_google_1", text: "google (3)" }],
        ],
        input: [
          { count: 5, id: "anthropic" },
          { count: 8, id: "openai" },
          { count: 3, id: "google" },
        ],
        name: "wraps overflow to second row",
      },
    ] as const satisfies {
      name: string;
      input: ProviderInfo[];
      expected: ReturnType<typeof buildProviderKeyboard>;
    }[];

    for (const testCase of cases) {
      expect(buildProviderKeyboard(testCase.input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("buildModelsKeyboard", () => {
  it("shows back button for empty models", () => {
    const result = buildModelsKeyboard({
      currentPage: 1,
      models: [],
      provider: "anthropic",
      totalPages: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.[0]?.text).toBe("<< Back");
    expect(result[0]?.[0]?.callback_data).toBe("mdl_back");
  });

  it("renders model rows and optional current-model indicator", () => {
    const cases = [
      {
        currentModel: undefined,
        firstText: "claude-sonnet-4",
        name: "no current model",
      },
      {
        currentModel: "anthropic/claude-sonnet-4",
        firstText: "claude-sonnet-4 ✓",
        name: "current model marked",
      },
      {
        currentModel: "claude-sonnet-4",
        firstText: "claude-sonnet-4 ✓",
        name: "legacy bare model id fallback still marks current model",
      },
    ] as const;
    for (const testCase of cases) {
      const result = buildModelsKeyboard({
        currentModel: testCase.currentModel,
        currentPage: 1,
        models: ["claude-sonnet-4", "claude-opus-4"],
        provider: "anthropic",
        totalPages: 1,
      });
      // 2 model rows + back button
      expect(result, testCase.name).toHaveLength(3);
      expect(result[0]?.[0]?.text).toBe(testCase.firstText);
      expect(result[0]?.[0]?.callback_data).toBe("mdl_sel_anthropic/claude-sonnet-4");
      expect(result[1]?.[0]?.text).toBe("claude-opus-4");
      expect(result[2]?.[0]?.text).toBe("<< Back");
    }
  });

  it("uses modelNames for display text when provided", () => {
    const modelNames = new Map([
      ["nexos/a1b2c3d4-e5f6-7890-abcd-ef1234567890", "Claude Sonnet 4"],
      ["nexos/claude-opus-4", "Claude Opus 4"],
    ]);
    const result = buildModelsKeyboard({
      currentPage: 1,
      modelNames,
      models: ["a1b2c3d4-e5f6-7890-abcd-ef1234567890", "claude-opus-4"],
      provider: "nexos",
      totalPages: 1,
    });
    // 2 model rows + back button
    expect(result).toHaveLength(3);
    expect(result[0]?.[0]?.text).toBe("Claude Sonnet 4");
    expect(result[1]?.[0]?.text).toBe("Claude Opus 4");
    // Callback_data still uses the raw model ID, not the display name
    expect(result[0]?.[0]?.callback_data).toBe(
      "mdl_sel_nexos/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
  });

  it("falls back to model ID when modelNames does not contain an entry", () => {
    const modelNames = new Map([["anthropic/known-id", "Known Model"]]);
    const result = buildModelsKeyboard({
      currentPage: 1,
      modelNames,
      models: ["known-id", "unknown-id"],
      provider: "anthropic",
      totalPages: 1,
    });
    expect(result[0]?.[0]?.text).toBe("Known Model");
    expect(result[1]?.[0]?.text).toBe("unknown-id");
  });

  it("uses provider-scoped modelNames keys to avoid cross-provider collisions", () => {
    const modelNames = new Map([
      ["openai/shared-id", "OpenAI Shared"],
      ["anthropic/shared-id", "Anthropic Shared"],
    ]);

    const openaiResult = buildModelsKeyboard({
      currentPage: 1,
      modelNames,
      models: ["shared-id"],
      provider: "openai",
      totalPages: 1,
    });
    const anthropicResult = buildModelsKeyboard({
      currentPage: 1,
      modelNames,
      models: ["shared-id"],
      provider: "anthropic",
      totalPages: 1,
    });

    expect(openaiResult[0]?.[0]?.text).toBe("OpenAI Shared");
    expect(anthropicResult[0]?.[0]?.text).toBe("Anthropic Shared");
  });

  it("does not mark same-id models from other providers as current", () => {
    const result = buildModelsKeyboard({
      currentModel: "github-copilot/gpt-5.4",
      currentPage: 1,
      models: ["gpt-5.4", "gpt-5.3-codex-spark"],
      provider: "openai-codex",
      totalPages: 1,
    });

    const texts = result.flat().map((button) => button.text);
    expect(texts).toContain("gpt-5.4");
    expect(texts).not.toContain("gpt-5.4 ✓");
  });

  it("renders pagination controls for first, middle, and last pages", () => {
    const cases = [
      {
        expectedPagination: ["1/3", "Next ▶"],
        name: "first page",
        params: { currentPage: 1, models: ["model1", "model2"] },
      },
      {
        expectedPagination: ["◀ Prev", "2/3", "Next ▶"],
        name: "middle page",
        params: {
          currentPage: 2,
          models: ["model1", "model2", "model3", "model4", "model5", "model6"],
        },
      },
      {
        expectedPagination: ["◀ Prev", "3/3"],
        name: "last page",
        params: {
          currentPage: 3,
          models: ["model1", "model2", "model3", "model4", "model5", "model6"],
        },
      },
    ] as const;
    for (const testCase of cases) {
      const result = buildModelsKeyboard({
        currentPage: testCase.params.currentPage,
        models: [...testCase.params.models],
        pageSize: 2,
        provider: "anthropic",
        totalPages: 3,
      });
      // 2 model rows + pagination row + back button
      expect(result, testCase.name).toHaveLength(4);
      expect(result[2]?.map((button) => button.text)).toEqual(testCase.expectedPagination);
    }
  });

  it("keeps short display IDs untouched and truncates overly long IDs", () => {
    const cases = [
      {
        expected: "claude-3-5-sonnet-20241022-with-suffix",
        model: "claude-3-5-sonnet-20241022-with-suffix",
        name: "max-length display",
        provider: "anthropic",
      },
      {
        maxLength: 38,
        model: "this-model-name-is-long-enough-to-need-truncation-abcd",
        name: "overly long display",
        provider: "a",
        startsWith: "…",
      },
    ] as const;
    for (const testCase of cases) {
      const result = buildModelsKeyboard({
        currentPage: 1,
        models: [testCase.model],
        provider: testCase.provider,
        totalPages: 1,
      });
      const text = result[0]?.[0]?.text;
      if ("expected" in testCase) {
        expect(text, testCase.name).toBe(testCase.expected);
      } else {
        expect(text?.startsWith(testCase.startsWith), testCase.name).toBe(true);
        expect(text?.length, testCase.name).toBeLessThanOrEqual(testCase.maxLength);
      }
    }
  });

  it("uses compact selection callback when provider/model callback exceeds 64 bytes", () => {
    const model = "us.anthropic.claude-3-5-sonnet-20240620-v1:0";
    const result = buildModelsKeyboard({
      currentPage: 1,
      models: [model],
      provider: "amazon-bedrock",
      totalPages: 1,
    });

    expect(result[0]?.[0]?.callback_data).toBe(`mdl_sel/${model}`);
  });
});

describe("buildBrowseProvidersButton", () => {
  it("returns browse providers button", () => {
    const result = buildBrowseProvidersButton();
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0]?.[0]?.text).toBe("Browse providers");
    expect(result[0]?.[0]?.callback_data).toBe("mdl_prov");
  });
});

describe("getModelsPageSize", () => {
  it("returns default page size", () => {
    expect(getModelsPageSize()).toBe(8);
  });
});

describe("calculateTotalPages", () => {
  it("calculates pages correctly", () => {
    expect(calculateTotalPages(0)).toBe(0);
    expect(calculateTotalPages(1)).toBe(1);
    expect(calculateTotalPages(8)).toBe(1);
    expect(calculateTotalPages(9)).toBe(2);
    expect(calculateTotalPages(16)).toBe(2);
    expect(calculateTotalPages(17)).toBe(3);
  });

  it("uses custom page size", () => {
    expect(calculateTotalPages(10, 5)).toBe(2);
    expect(calculateTotalPages(11, 5)).toBe(3);
  });
});

describe("large model lists (OpenRouter-scale)", () => {
  it("handles 100+ models with pagination", () => {
    const models = Array.from({ length: 150 }, (_, i) => `model-${i}`);
    const totalPages = calculateTotalPages(models.length);
    expect(totalPages).toBe(19); // 150 / 8 = 18.75 -> 19 pages

    // Test first page
    const firstPage = buildModelsKeyboard({
      currentPage: 1,
      models,
      provider: "openrouter",
      totalPages,
    });
    expect(firstPage.length).toBe(10); // 8 models + pagination + back
    expect(firstPage[0]?.[0]?.text).toBe("model-0");
    expect(firstPage[7]?.[0]?.text).toBe("model-7");

    // Test last page
    const lastPage = buildModelsKeyboard({
      currentPage: 19,
      models,
      provider: "openrouter",
      totalPages,
    });
    // Last page has 150 - (18 * 8) = 6 models
    expect(lastPage.length).toBe(8); // 6 models + pagination + back
    expect(lastPage[0]?.[0]?.text).toBe("model-144");
  });

  it("all callback_data stays within 64-byte limit", () => {
    // Realistic OpenRouter model IDs
    const models = [
      "anthropic/claude-3-5-sonnet-20241022",
      "google/gemini-2.0-flash-thinking-exp:free",
      "deepseek/deepseek-r1-distill-llama-70b",
      "meta-llama/llama-3.3-70b-instruct:nitro",
      "nousresearch/hermes-3-llama-3.1-405b:extended",
    ];
    const result = buildModelsKeyboard({
      currentPage: 1,
      models,
      provider: "openrouter",
      totalPages: 1,
    });

    for (const row of result) {
      for (const button of row) {
        const bytes = Buffer.byteLength(button.callback_data, "utf8");
        expect(bytes).toBeLessThanOrEqual(64);
      }
    }
  });

  it("skips models that would exceed callback_data limit", () => {
    const models = [
      "short-model",
      "this-is-an-extremely-long-model-name-that-definitely-exceeds-the-sixty-four-byte-limit",
      "another-short",
    ];
    const result = buildModelsKeyboard({
      currentPage: 1,
      models,
      provider: "openrouter",
      totalPages: 1,
    });

    // Should have 2 model buttons (skipping the long one) + back
    const modelButtons = result.filter((row) => !row[0]?.callback_data.startsWith("mdl_back"));
    expect(modelButtons.length).toBe(2);
    expect(modelButtons[0]?.[0]?.text).toBe("short-model");
    expect(modelButtons[1]?.[0]?.text).toBe("another-short");
  });
});
