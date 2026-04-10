import type { Api, Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderModernModelRef: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderModernModelRef: providerRuntimeMocks.resolveProviderModernModelRef,
  };
});

import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT,
  isHighSignalLiveModelRef,
  isModernModelRef,
  resolveHighSignalLiveModelLimit,
  selectHighSignalLiveItems,
} from "./live-model-filter.js";

const baseModel = (): Model<Api> =>
  ({
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    contextWindow: 8192,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: "glm-4.7",
    input: ["text"],
    maxTokens: 1024,
    name: "GLM-4.7",
    provider: "zai",
    reasoning: true,
  }) as Model<Api>;

function supportsDeveloperRole(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
}

function supportsUsageInStreaming(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsUsageInStreaming?: boolean } | undefined)
    ?.supportsUsageInStreaming;
}

function supportsStrictMode(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsStrictMode?: boolean } | undefined)?.supportsStrictMode;
}

function expectSupportsDeveloperRoleForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsDeveloperRole(normalized)).toBe(false);
}

function expectSupportsUsageInStreamingForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsUsageInStreaming(normalized)).toBe(false);
}

function expectSupportsStrictModeForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsStrictMode(normalized)).toBe(false);
}

beforeEach(() => {
  providerRuntimeMocks.resolveProviderModernModelRef.mockReset();
  providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(undefined);
});

describe("normalizeModelCompat — Anthropic baseUrl", () => {
  const anthropicBase = (): Model<Api> =>
    ({
      api: "anthropic-messages",
      contextWindow: 200_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: "claude-opus-4-6",
      input: ["text"],
      maxTokens: 8192,
      name: "claude-opus-4-6",
      provider: "anthropic",
      reasoning: true,
    }) as Model<Api>;

  it("strips /v1 suffix from anthropic-messages baseUrl", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com/v1" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("strips trailing /v1/ (with slash) from anthropic-messages baseUrl", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com/v1/" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("leaves anthropic-messages baseUrl without /v1 unchanged", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("leaves baseUrl undefined unchanged for anthropic-messages", () => {
    const model = anthropicBase();
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBeUndefined();
  });

  it("does not strip /v1 from non-anthropic-messages models", () => {
    const model = {
      ...baseModel(),
      api: "openai-responses" as Api,
      baseUrl: "https://api.openai.com/v1",
      provider: "openai",
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("strips /v1 from custom Anthropic proxy baseUrl", () => {
    const model = {
      ...anthropicBase(),
      baseUrl: "https://my-proxy.example.com/anthropic/v1",
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://my-proxy.example.com/anthropic");
  });
});

describe("normalizeModelCompat", () => {
  it("forces supportsDeveloperRole off for z.ai models", () => {
    expectSupportsDeveloperRoleForcedOff();
  });

  it("forces supportsDeveloperRole off for moonshot models", () => {
    expectSupportsDeveloperRoleForcedOff({
      baseUrl: "https://api.moonshot.ai/v1",
      provider: "moonshot",
    });
  });

  it("forces supportsDeveloperRole off for custom moonshot-compatible endpoints", () => {
    expectSupportsDeveloperRoleForcedOff({
      baseUrl: "https://api.moonshot.cn/v1",
      provider: "custom-kimi",
    });
  });

  it("forces supportsDeveloperRole off for DashScope provider ids", () => {
    expectSupportsDeveloperRoleForcedOff({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      provider: "dashscope",
    });
  });

  it("forces supportsDeveloperRole off for DashScope-compatible endpoints", () => {
    expectSupportsDeveloperRoleForcedOff({
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      provider: "custom-qwen",
    });
  });

  it("keeps supportsUsageInStreaming on for native Qwen endpoints", () => {
    const model = {
      ...baseModel(),
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      provider: "qwen",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("keeps supportsUsageInStreaming on for DashScope-compatible endpoints regardless of provider id", () => {
    const model = {
      ...baseModel(),
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      provider: "custom-qwen",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("keeps supportsUsageInStreaming on for Moonshot-native endpoints regardless of provider id", () => {
    const model = {
      ...baseModel(),
      baseUrl: "https://api.moonshot.ai/v1",
      provider: "custom-kimi",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("leaves native api.openai.com model untouched", () => {
    const model = {
      ...baseModel(),
      baseUrl: "https://api.openai.com/v1",
      provider: "openai",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat).toBeUndefined();
  });

  it("forces supportsDeveloperRole off for Azure OpenAI (Chat Completions, not Responses API)", () => {
    expectSupportsDeveloperRoleForcedOff({
      baseUrl: "https://my-deployment.openai.azure.com/openai",
      provider: "azure-openai",
    });
  });
  it("forces supportsDeveloperRole off for generic custom openai-completions provider", () => {
    expectSupportsDeveloperRoleForcedOff({
      baseUrl: "https://cpa.example.com/v1",
      provider: "custom-cpa",
    });
  });

  it("forces supportsUsageInStreaming off for generic custom openai-completions provider", () => {
    expectSupportsUsageInStreamingForcedOff({
      baseUrl: "https://cpa.example.com/v1",
      provider: "custom-cpa",
    });
  });

  it("forces supportsStrictMode off for z.ai models", () => {
    expectSupportsStrictModeForcedOff();
  });

  it("forces supportsStrictMode off for custom openai-completions provider", () => {
    expectSupportsStrictModeForcedOff({
      baseUrl: "https://cpa.example.com/v1",
      provider: "custom-cpa",
    });
  });

  it("forces supportsDeveloperRole off for Qwen proxy via openai-completions", () => {
    expectSupportsDeveloperRoleForcedOff({
      baseUrl: "https://qwen-api.example.org/compatible-mode/v1",
      provider: "qwen-proxy",
    });
  });

  it("leaves openai-completions model with empty baseUrl untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
    };
    delete (model as { baseUrl?: unknown }).baseUrl;
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model as Model<Api>);
    expect(normalized.compat).toBeUndefined();
  });

  it("forces supportsDeveloperRole off for malformed baseUrl values", () => {
    expectSupportsDeveloperRoleForcedOff({
      baseUrl: "://api.openai.com malformed",
      provider: "custom-cpa",
    });
  });

  it("respects explicit supportsDeveloperRole true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsDeveloperRole: true },
      provider: "custom-cpa",
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(true);
  });

  it("respects explicit supportsUsageInStreaming true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsUsageInStreaming: true },
      provider: "custom-cpa",
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
  });

  it("preserves explicit supportsUsageInStreaming false on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsUsageInStreaming: false },
      provider: "custom-cpa",
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
  });

  it("still forces flags off when not explicitly set by user", () => {
    const model = {
      ...baseModel(),
      baseUrl: "https://proxy.example.com/v1",
      provider: "custom-cpa",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("respects explicit supportsStrictMode true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsStrictMode: true },
      provider: "custom-cpa",
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsStrictMode(normalized)).toBe(true);
  });

  it("does not mutate caller model when forcing supportsDeveloperRole off", () => {
    const model = {
      ...baseModel(),
      baseUrl: "https://proxy.example.com/v1",
      provider: "custom-cpa",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized).not.toBe(model);
    expect(supportsDeveloperRole(model)).toBeUndefined();
    expect(supportsUsageInStreaming(model)).toBeUndefined();
    expect(supportsStrictMode(model)).toBeUndefined();
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("does not override explicit compat false", () => {
    const model = baseModel();
    model.compat = {
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: false,
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("leaves fully explicit non-native compat untouched", () => {
    const model = baseModel();
    model.baseUrl = "https://proxy.example.com/v1";
    model.compat = {
      supportsDeveloperRole: false,
      supportsStrictMode: true,
      supportsUsageInStreaming: true,
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized).toBe(model);
  });

  it("preserves explicit usage compat when developer role is explicitly enabled", () => {
    const model = baseModel();
    model.baseUrl = "https://proxy.example.com/v1";
    model.compat = {
      supportsDeveloperRole: true,
      supportsStrictMode: true,
      supportsUsageInStreaming: true,
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(true);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
    expect(supportsStrictMode(normalized)).toBe(true);
  });
});

describe("isModernModelRef", () => {
  it("uses provider runtime hooks before fallback heuristics", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(false);

    expect(isModernModelRef({ id: "claude-opus-4-6", provider: "openrouter" })).toBe(false);
  });

  it("includes plugin-advertised modern models", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "openai" &&
      ["gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano"].includes(context.modelId)
        ? true
        : provider === "openai-codex" && ["gpt-5.4", "gpt-5.4-mini"].includes(context.modelId)
          ? true
          : provider === "opencode" && ["claude-opus-4-6", "gemini-3-pro"].includes(context.modelId)
            ? true
            : provider === "opencode-go"
              ? true
              : undefined,
    );

    expect(isModernModelRef({ id: "gpt-5.4", provider: "openai" })).toBe(true);
    expect(isModernModelRef({ id: "gpt-5.4-pro", provider: "openai" })).toBe(true);
    expect(isModernModelRef({ id: "gpt-5.4-mini", provider: "openai" })).toBe(true);
    expect(isModernModelRef({ id: "gpt-5.4-nano", provider: "openai" })).toBe(true);
    expect(isModernModelRef({ id: "gpt-5.4", provider: "openai-codex" })).toBe(true);
    expect(isModernModelRef({ id: "gpt-5.4-mini", provider: "openai-codex" })).toBe(true);
    expect(isModernModelRef({ id: "claude-opus-4-6", provider: "opencode" })).toBe(true);
    expect(isModernModelRef({ id: "gemini-3-pro", provider: "opencode" })).toBe(true);
    expect(isModernModelRef({ id: "kimi-k2.5", provider: "opencode-go" })).toBe(true);
    expect(isModernModelRef({ id: "glm-5", provider: "opencode-go" })).toBe(true);
    expect(isModernModelRef({ id: "minimax-m2.7", provider: "opencode-go" })).toBe(true);
  });

  it("matches plugin-advertised modern models across canonical provider aliases", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "zai" && context.modelId === "glm-5" ? true : undefined,
    );

    expect(isModernModelRef({ id: "glm-5", provider: "z.ai" })).toBe(true);
    expect(isModernModelRef({ id: "glm-5", provider: "z-ai" })).toBe(true);
  });

  it("excludes provider-declined modern models", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "opencode" && context.modelId === "minimax-m2.7" ? false : undefined,
    );

    expect(isModernModelRef({ id: "minimax-m2.7", provider: "opencode" })).toBe(false);
  });
});

describe("isHighSignalLiveModelRef", () => {
  it("keeps modern higher-signal Claude families", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "anthropic" && ["claude-sonnet-4-6", "claude-opus-4-6"].includes(context.modelId)
        ? true
        : undefined,
    );

    expect(isHighSignalLiveModelRef({ id: "claude-sonnet-4-6", provider: "anthropic" })).toBe(true);
    expect(isHighSignalLiveModelRef({ id: "claude-opus-4-6", provider: "anthropic" })).toBe(true);
  });

  it("drops low-signal or old Claude variants even when provider marks them modern", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(isHighSignalLiveModelRef({ id: "claude-opus-4-5", provider: "anthropic" })).toBe(false);
    expect(
      isHighSignalLiveModelRef({ id: "claude-haiku-4-5-20251001", provider: "anthropic" }),
    ).toBe(false);
    expect(
      isHighSignalLiveModelRef({ id: "claude-3-5-haiku-20241022", provider: "opencode" }),
    ).toBe(false);
  });

  it("drops Gemini families older than major version 3 from the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(isHighSignalLiveModelRef({ id: "gemini-2.5-flash-lite", provider: "google" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ id: "google/gemini-2.5-pro", provider: "openrouter" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ id: "gemini-3-flash-preview", provider: "google" })).toBe(
      true,
    );
  });
});

describe("selectHighSignalLiveItems", () => {
  it("prefers curated Google replacements before fallback provider spread", () => {
    const items = [
      { id: "claude-opus-4-6", provider: "anthropic" },
      { id: "gemini-3.1-pro-preview", provider: "google" },
      { id: "gemini-3-flash-preview", provider: "google" },
      { id: "gpt-5.2", provider: "openai" },
      { id: "big-pickle", provider: "opencode" },
    ];

    expect(
      selectHighSignalLiveItems(
        items,
        4,
        (item) => item,
        (item) => item.provider,
      ),
    ).toEqual([
      { id: "claude-opus-4-6", provider: "anthropic" },
      { id: "gemini-3.1-pro-preview", provider: "google" },
      { id: "gemini-3-flash-preview", provider: "google" },
      { id: "gpt-5.2", provider: "openai" },
    ]);
  });
});

describe("resolveHighSignalLiveModelLimit", () => {
  it("defaults modern live sweeps to the curated high-signal cap", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        useExplicitModels: false,
      }),
    ).toBe(DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT);
  });

  it("leaves explicit model lists uncapped unless a cap is provided", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        useExplicitModels: true,
      }),
    ).toBe(0);
    expect(
      resolveHighSignalLiveModelLimit({
        rawMaxModels: "3",
        useExplicitModels: true,
      }),
    ).toBe(3);
  });
});
