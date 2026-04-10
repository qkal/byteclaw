import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  isCliProvider,
  modelKey,
  normalizeModelSelection,
  normalizeProviderId,
  normalizeProviderIdForAuth,
  parseModelRef,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
  resolvePersistedModelRef,
  resolvePersistedOverrideModelRef,
  resolvePersistedSelectedModelRef,
  resolveSubagentConfiguredModelSelection,
  resolveThinkingDefault,
} from "./model-selection.js";

const EXPLICIT_ALLOWLIST_CONFIG = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
      },
    },
  },
} as OpenClawConfig;

const BUNDLED_ALLOWLIST_CATALOG = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "gpt-5.4", name: "gpt-5.4", provider: "openai" },
];

const ANTHROPIC_OPUS_CATALOG = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    reasoning: true,
  },
];

function resolveAnthropicOpusThinking(cfg: OpenClawConfig) {
  return resolveThinkingDefault({
    catalog: ANTHROPIC_OPUS_CATALOG,
    cfg,
    model: "claude-opus-4-6",
    provider: "anthropic",
  });
}

function createAgentFallbackConfig(params: {
  primary?: string;
  fallbacks?: string[];
  agentFallbacks?: string[];
}) {
  return {
    agents: {
      defaults: {
        model: {
          fallbacks: params.fallbacks ?? [],
          primary: params.primary ?? "openai/gpt-4o",
        },
        models: {
          "openai/gpt-4o": {},
        },
      },
      ...(params.agentFallbacks
        ? {
            list: [
              {
                id: "coder",
                model: {
                  fallbacks: params.agentFallbacks,
                  primary: params.primary ?? "openai/gpt-4o",
                },
              },
            ],
          }
        : {}),
    },
  } as OpenClawConfig;
}

function createProviderWithModelsConfig(provider: string, models: Record<string, unknown>[]) {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: `https://${provider}.example.com`,
          models,
        },
      },
    },
  } as Partial<OpenClawConfig>;
}

function resolveConfiguredRefForTest(cfg: Partial<OpenClawConfig>) {
  return resolveConfiguredModelRef({
    cfg: cfg as OpenClawConfig,
    defaultModel: "gpt-5.4",
    defaultProvider: "openai",
  });
}

describe("model-selection", () => {
  describe("normalizeProviderId", () => {
    it("should normalize provider names", () => {
      expect(normalizeProviderId("Anthropic")).toBe("anthropic");
      expect(normalizeProviderId("Z.ai")).toBe("zai");
      expect(normalizeProviderId("z-ai")).toBe("zai");
      expect(normalizeProviderId("OpenCode-Zen")).toBe("opencode");
      expect(normalizeProviderId("qwen")).toBe("qwen");
      expect(normalizeProviderId("kimi-code")).toBe("kimi");
      expect(normalizeProviderId("kimi-coding")).toBe("kimi");
      expect(normalizeProviderId("bedrock")).toBe("amazon-bedrock");
      expect(normalizeProviderId("aws-bedrock")).toBe("amazon-bedrock");
      expect(normalizeProviderId("amazon-bedrock")).toBe("amazon-bedrock");
    });
  });

  describe("normalizeProviderIdForAuth", () => {
    it("only applies generic provider-id normalization before auth alias lookup", () => {
      expect(normalizeProviderIdForAuth("qwencloud")).toBe("qwen");
      expect(normalizeProviderIdForAuth("openai-codex")).toBe("openai-codex");
      expect(normalizeProviderIdForAuth("openai")).toBe("openai");
    });
  });

  describe("isCliProvider", () => {
    it("returns true for setup-registered cli backends", () => {
      expect(isCliProvider("claude-cli", {} as OpenClawConfig)).toBe(true);
    });

    it("returns false for provider ids", () => {
      expect(isCliProvider("example-cli", {} as OpenClawConfig)).toBe(false);
    });
  });

  describe("modelKey", () => {
    it("keeps canonical OpenRouter native ids without duplicating the provider", () => {
      expect(modelKey("openrouter", "openrouter/hunter-alpha")).toBe("openrouter/hunter-alpha");
    });
  });

  describe("parseModelRef", () => {
    const expectParsedModelVariants = (
      variants: string[],
      defaultProvider: string,
      expected: { provider: string; model: string },
    ) => {
      for (const raw of variants) {
        expect(parseModelRef(raw, defaultProvider), raw).toEqual(expected);
      }
    };

    it.each([
      {
        defaultProvider: "openai",
        expected: { model: "claude-3-5-sonnet", provider: "anthropic" },
        name: "parses explicit provider/model refs",
        variants: ["anthropic/claude-3-5-sonnet"],
      },
      {
        defaultProvider: "anthropic",
        expected: { model: "claude-3-5-sonnet", provider: "anthropic" },
        name: "uses the default provider when omitted",
        variants: ["claude-3-5-sonnet"],
      },
      {
        defaultProvider: "anthropic",
        expected: { model: "moonshotai/kimi-k2.5", provider: "nvidia" },
        name: "preserves nested model ids after the provider prefix",
        variants: ["nvidia/moonshotai/kimi-k2.5"],
      },
      {
        defaultProvider: "anthropic",
        expected: { model: "claude-opus-4-6", provider: "anthropic" },
        name: "normalizes anthropic shorthand aliases",
        variants: ["anthropic/opus-4.6", "opus-4.6", " anthropic / opus-4.6 "],
      },
      {
        defaultProvider: "anthropic",
        expected: { model: "claude-sonnet-4-6", provider: "anthropic" },
        name: "normalizes anthropic sonnet aliases",
        variants: ["anthropic/sonnet-4.6", "sonnet-4.6"],
      },
      {
        defaultProvider: "anthropic",
        expected: { model: "claude-sonnet-4-20250514", provider: "anthropic" },
        name: "keeps dated anthropic model ids unchanged",
        variants: ["anthropic/claude-sonnet-4-20250514", "claude-sonnet-4-20250514"],
      },
      {
        defaultProvider: "google",
        expected: { model: "gemini-3-flash-preview", provider: "google" },
        name: "normalizes deprecated google flash preview ids",
        variants: ["google/gemini-3.1-flash-preview", "gemini-3.1-flash-preview"],
      },
      {
        defaultProvider: "google",
        expected: { model: "gemini-3.1-flash-lite-preview", provider: "google" },
        name: "normalizes gemini 3.1 flash-lite ids",
        variants: ["google/gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
      },
      {
        defaultProvider: "xai",
        expected: { model: "grok-4.20-beta-latest-reasoning", provider: "xai" },
        name: "normalizes deprecated xai grok 4.20 beta ids",
        variants: [
          "xai/grok-4.20-experimental-beta-0304-reasoning",
          "grok-4.20-experimental-beta-0304-reasoning",
        ],
      },
      {
        defaultProvider: "openai",
        expected: { model: "gpt-5.4", provider: "openai" },
        name: "keeps OpenAI codex refs on the openai provider",
        variants: ["openai/gpt-5.4", "gpt-5.4"],
      },
      {
        defaultProvider: "openai",
        expected: { model: "openrouter/aurora-alpha", provider: "openrouter" },
        name: "preserves openrouter native model prefixes",
        variants: ["openrouter/aurora-alpha"],
      },
      {
        defaultProvider: "openai",
        expected: { model: "anthropic/claude-sonnet-4-6", provider: "openrouter" },
        name: "passes through openrouter upstream provider ids",
        variants: ["openrouter/anthropic/claude-sonnet-4-6"],
      },
      {
        defaultProvider: "huggingface",
        expected: { model: "deepseek-ai/DeepSeek-R1", provider: "huggingface" },
        name: "strips duplicate Hugging Face provider prefixes",
        variants: ["huggingface/deepseek-ai/DeepSeek-R1"],
      },
      {
        defaultProvider: "openai",
        expected: { model: "anthropic/claude-opus-4.6", provider: "vercel-ai-gateway" },
        name: "normalizes Vercel Claude shorthand to anthropic-prefixed model ids",
        variants: ["vercel-ai-gateway/claude-opus-4.6"],
      },
      {
        defaultProvider: "openai",
        expected: { model: "anthropic/claude-opus-4-6", provider: "vercel-ai-gateway" },
        name: "normalizes Vercel Anthropic aliases without double-prefixing",
        variants: ["vercel-ai-gateway/opus-4.6"],
      },
      {
        defaultProvider: "openai",
        expected: { model: "anthropic/claude-opus-4.6", provider: "vercel-ai-gateway" },
        name: "keeps already-prefixed Vercel Anthropic models unchanged",
        variants: ["vercel-ai-gateway/anthropic/claude-opus-4.6"],
      },
      {
        defaultProvider: "openai",
        expected: { model: "openai/gpt-5.4", provider: "vercel-ai-gateway" },
        name: "passes through non-Claude Vercel model ids unchanged",
        variants: ["vercel-ai-gateway/openai/gpt-5.4"],
      },
      {
        defaultProvider: "anthropic",
        expected: { model: "gpt-5.4-codex-codex", provider: "openai" },
        name: "keeps already-suffixed codex variants unchanged",
        variants: ["openai/gpt-5.4-codex-codex"],
      },
      {
        defaultProvider: "google-vertex",
        expected: { model: "gemini-3.1-flash-lite-preview", provider: "google-vertex" },
        name: "normalizes gemini 3.1 flash-lite ids for google-vertex",
        variants: ["google-vertex/gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
      },
    ])("$name", ({ variants, defaultProvider, expected }) => {
      expectParsedModelVariants(variants, defaultProvider, expected);
    });

    it("round-trips normalized refs through modelKey", () => {
      const parsed = parseModelRef(" opus-4.6 ", "anthropic");
      expect(parsed).toEqual({ model: "claude-opus-4-6", provider: "anthropic" });
      expect(modelKey(parsed?.provider ?? "", parsed?.model ?? "")).toBe(
        "anthropic/claude-opus-4-6",
      );
    });
    it.each(["", "  ", "/", "anthropic/", "/model"])("returns null for invalid ref %j", (raw) => {
      expect(parseModelRef(raw, "anthropic")).toBeNull();
    });
  });

  describe("resolvePersistedModelRef", () => {
    it("splits legacy combined refs when provider is not stored separately", () => {
      expect(
        resolvePersistedModelRef({
          defaultProvider: "anthropic",
          overrideModel: "ollama-beelink2/qwen2.5-coder:7b",
        }),
      ).toEqual({
        model: "qwen2.5-coder:7b",
        provider: "ollama-beelink2",
      });
    });

    it("preserves explicit runtime provider for vendor-prefixed model ids", () => {
      expect(
        resolvePersistedModelRef({
          defaultProvider: "anthropic",
          runtimeModel: "anthropic/claude-haiku-4.5",
          runtimeProvider: "openrouter",
        }),
      ).toEqual({
        model: "anthropic/claude-haiku-4.5",
        provider: "openrouter",
      });
    });

    it("normalizes explicit override providers without reparsing runtime semantics", () => {
      expect(
        resolvePersistedModelRef({
          defaultProvider: "anthropic",
          overrideModel: "kimi-code",
          overrideProvider: "kimi-coding",
        }),
      ).toEqual({
        model: "kimi-code",
        provider: "kimi",
      });
    });
  });

  describe("resolvePersistedOverrideModelRef", () => {
    it("splits legacy combined override refs when provider is not stored separately", () => {
      expect(
        resolvePersistedOverrideModelRef({
          defaultProvider: "anthropic",
          overrideModel: "ollama-beelink2/qwen2.5-coder:7b",
        }),
      ).toEqual({
        model: "qwen2.5-coder:7b",
        provider: "ollama-beelink2",
      });
    });

    it("normalizes explicit override providers without reparsing away wrapper semantics", () => {
      expect(
        resolvePersistedOverrideModelRef({
          defaultProvider: "anthropic",
          overrideModel: "kimi-code",
          overrideProvider: "kimi-coding",
        }),
      ).toEqual({
        model: "kimi-code",
        provider: "kimi",
      });
    });
  });

  describe("resolvePersistedSelectedModelRef", () => {
    it("prefers explicit overrides ahead of runtime model fields", () => {
      expect(
        resolvePersistedSelectedModelRef({
          defaultProvider: "anthropic",
          overrideModel: "claude-opus-4-6",
          overrideProvider: "anthropic",
          runtimeModel: "gpt-5.4",
          runtimeProvider: "openai-codex",
        }),
      ).toEqual({
        model: "claude-opus-4-6",
        provider: "anthropic",
      });
    });

    it("preserves explicit wrapper providers for vendor-prefixed override models", () => {
      expect(
        resolvePersistedSelectedModelRef({
          defaultProvider: "anthropic",
          overrideModel: "anthropic/claude-haiku-4.5",
          overrideProvider: "openrouter",
          runtimeModel: "openrouter/free",
          runtimeProvider: "openrouter",
        }),
      ).toEqual({
        model: "anthropic/claude-haiku-4.5",
        provider: "openrouter",
      });
    });
  });

  describe("inferUniqueProviderFromConfiguredModels", () => {
    it("infers provider when configured model match is unique", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "claude-sonnet-4-6",
        }),
      ).toBe("anthropic");
    });

    it("returns undefined when configured matches are ambiguous", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
              "minimax/claude-sonnet-4-6": {},
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "claude-sonnet-4-6",
        }),
      ).toBeUndefined();
    });

    it("returns undefined for provider-prefixed model ids", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "anthropic/claude-sonnet-4-6",
        }),
      ).toBeUndefined();
    });

    it("infers provider for slash-containing model id when allowlist match is unique", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "anthropic/claude-sonnet-4-6",
        }),
      ).toBe("vercel-ai-gateway");
    });

    it("infers provider from configured provider catalogs when allowlist is absent", () => {
      const cfg = {
        models: {
          providers: {
            "qwen-dashscope": {
              models: [{ id: "qwen-max" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "qwen-max",
        }),
      ).toBe("qwen-dashscope");
    });

    it("returns undefined when provider catalog matches are ambiguous", () => {
      const cfg = {
        models: {
          providers: {
            qwen: {
              models: [{ id: "qwen-max" }],
            },
            "qwen-dashscope": {
              models: [{ id: "qwen-max" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "qwen-max",
        }),
      ).toBeUndefined();
    });
  });

  describe("buildModelAliasIndex", () => {
    it("should build alias index from config", () => {
      const cfg: Partial<OpenClawConfig> = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-3-5-sonnet": { alias: "fast" },
              "openai/gpt-4o": { alias: "smart" },
            },
          },
        },
      };

      const index = buildModelAliasIndex({
        cfg: cfg as OpenClawConfig,
        defaultProvider: "anthropic",
      });

      expect(index.byAlias.get("fast")?.ref).toEqual({
        model: "claude-3-5-sonnet",
        provider: "anthropic",
      });
      expect(index.byAlias.get("smart")?.ref).toEqual({ model: "gpt-4o", provider: "openai" });
      expect(index.byKey.get(modelKey("anthropic", "claude-3-5-sonnet"))).toEqual(["fast"]);
    });
  });

  describe("buildAllowedModelSet", () => {
    it("keeps explicitly allowlisted models even when missing from bundled catalog", () => {
      const result = buildAllowedModelSet({
        catalog: BUNDLED_ALLOWLIST_CATALOG,
        cfg: EXPLICIT_ALLOWLIST_CONFIG,
        defaultProvider: "anthropic",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(true);
      expect(result.allowedCatalog).toEqual([
        {
          alias: "sonnet",
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.5",
          provider: "anthropic",
        },
      ]);
    });

    it("overlays configured provider metadata and alias onto matching catalog entries", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-z" },
            models: {
              "openai/gpt-test-z": { alias: "GPT Test Z Alias" },
            },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com",
              models: [
                {
                  contextWindow: 64_000,
                  id: "gpt-test-z",
                  name: "Configured GPT Test Z",
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        catalog: [{ id: "gpt-test-z", name: "gpt-test-z", provider: "openai" }],
        cfg,
        defaultProvider: "anthropic",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedCatalog).toEqual([
        {
          alias: "GPT Test Z Alias",
          contextWindow: 64_000,
          id: "gpt-test-z",
          name: "Configured GPT Test Z",
          provider: "openai",
        },
      ]);
    });

    it("applies configured provider metadata and alias to synthetic allowlist entries", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "nvidia/moonshotai/kimi-k2.5" },
            models: {
              "nvidia/moonshotai/kimi-k2.5": { alias: "Kimi K2.5 (NVIDIA)" },
            },
          },
        },
        models: {
          providers: {
            nvidia: {
              baseUrl: "https://nvidia.example.com",
              models: [
                {
                  contextWindow: 32_000,
                  id: "moonshotai/kimi-k2.5",
                  name: "Kimi K2.5 (Configured)",
                  reasoning: true,
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        catalog: [],
        cfg,
        defaultProvider: "anthropic",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedCatalog).toEqual([
        {
          alias: "Kimi K2.5 (NVIDIA)",
          contextWindow: 32_000,
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5 (Configured)",
          provider: "nvidia",
          reasoning: true,
        },
      ]);
    });

    it("includes fallback models in allowed set", () => {
      const cfg = createAgentFallbackConfig({
        fallbacks: ["anthropic/claude-sonnet-4-6", "google/gemini-3-pro"],
      });

      const result = buildAllowedModelSet({
        catalog: [],
        cfg,
        defaultModel: "gpt-4o",
        defaultProvider: "openai",
      });

      expect(result.allowedKeys.has("openai/gpt-4o")).toBe(true);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(true);
      expect(result.allowedKeys.has("google/gemini-3-pro-preview")).toBe(true);
      expect(result.allowAny).toBe(false);
    });

    it("handles empty fallbacks gracefully", () => {
      const cfg = createAgentFallbackConfig({});

      const result = buildAllowedModelSet({
        catalog: [],
        cfg,
        defaultModel: "gpt-4o",
        defaultProvider: "openai",
      });

      expect(result.allowedKeys.has("openai/gpt-4o")).toBe(true);
      expect(result.allowAny).toBe(false);
    });

    it("prefers per-agent fallback overrides when agentId is provided", () => {
      const cfg = createAgentFallbackConfig({
        agentFallbacks: ["anthropic/claude-sonnet-4-6"],
        fallbacks: ["google/gemini-3-pro"],
      });

      const result = buildAllowedModelSet({
        agentId: "coder",
        catalog: [],
        cfg,
        defaultModel: "gpt-4o",
        defaultProvider: "openai",
      });

      expect(result.allowedKeys.has("openai/gpt-4o")).toBe(true);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(true);
      expect(result.allowedKeys.has("google/gemini-3-pro-preview")).toBe(false);
      expect(result.allowAny).toBe(false);
    });
  });

  describe("resolveAllowedModelRef", () => {
    it("accepts explicit allowlist refs absent from bundled catalog", () => {
      const result = resolveAllowedModelRef({
        catalog: BUNDLED_ALLOWLIST_CATALOG,
        cfg: EXPLICIT_ALLOWLIST_CONFIG,
        defaultModel: "gpt-5.4",
        defaultProvider: "openai",
        raw: "anthropic/claude-sonnet-4-6",
      });

      expect(result).toEqual({
        key: "anthropic/claude-sonnet-4-6",
        ref: { model: "claude-sonnet-4-6", provider: "anthropic" },
      });
    });

    it("strips trailing auth profile suffix before allowlist matching", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/@cf/openai/gpt-oss-20b": {},
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveAllowedModelRef({
        catalog: [],
        cfg,
        defaultProvider: "anthropic",
        raw: "openai/@cf/openai/gpt-oss-20b@cf:default",
      });

      expect(result).toEqual({
        key: "openai/@cf/openai/gpt-oss-20b",
        ref: { model: "@cf/openai/gpt-oss-20b", provider: "openai" },
      });
    });

    it("infers provider from allowlist for bare model ids to prevent prefix drift (#48369)", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": {},
              "opencode-go/glm-5": {},
              "opencode-go/kimi-k2.5": {},
            },
          },
        },
      } as OpenClawConfig;

      // When session default is openai-codex, switching to a bare "kimi-k2.5"
      // Should resolve to opencode-go/kimi-k2.5, not openai-codex/kimi-k2.5
      const result = resolveAllowedModelRef({
        catalog: [],
        cfg,
        defaultProvider: "openai-codex",
        raw: "kimi-k2.5", // Session's current provider
      });

      expect(result).toEqual({
        key: "opencode-go/kimi-k2.5",
        ref: { model: "kimi-k2.5", provider: "opencode-go" },
      });
    });
  });

  describe("resolveModelRefFromString", () => {
    it("should resolve from string with alias", () => {
      const index = {
        byAlias: new Map([
          ["fast", { alias: "fast", ref: { model: "sonnet", provider: "anthropic" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        aliasIndex: index,
        defaultProvider: "openai",
        raw: "fast",
      });

      expect(resolved?.ref).toEqual({ model: "sonnet", provider: "anthropic" });
      expect(resolved?.alias).toBe("fast");
    });

    it("should resolve direct ref if no alias match", () => {
      const resolved = resolveModelRefFromString({
        defaultProvider: "anthropic",
        raw: "openai/gpt-4",
      });
      expect(resolved?.ref).toEqual({ model: "gpt-4", provider: "openai" });
    });

    it("strips trailing profile suffix for simple model refs", () => {
      const resolved = resolveModelRefFromString({
        defaultProvider: "openai",
        raw: "gpt-5@myprofile",
      });
      expect(resolved?.ref).toEqual({ model: "gpt-5", provider: "openai" });
    });

    it("strips trailing profile suffix for provider/model refs", () => {
      const resolved = resolveModelRefFromString({
        defaultProvider: "anthropic",
        raw: "google/gemini-flash-latest@google:bevfresh",
      });
      expect(resolved?.ref).toEqual({
        model: "gemini-flash-latest",
        provider: "google",
      });
    });

    it("preserves Cloudflare @cf model segments", () => {
      const resolved = resolveModelRefFromString({
        defaultProvider: "anthropic",
        raw: "openai/@cf/openai/gpt-oss-20b",
      });
      expect(resolved?.ref).toEqual({
        model: "@cf/openai/gpt-oss-20b",
        provider: "openai",
      });
    });

    it("preserves OpenRouter @preset model segments", () => {
      const resolved = resolveModelRefFromString({
        defaultProvider: "anthropic",
        raw: "openrouter/@preset/kimi-2-5",
      });
      expect(resolved?.ref).toEqual({
        model: "@preset/kimi-2-5",
        provider: "openrouter",
      });
    });

    it("splits trailing profile suffix after OpenRouter preset paths", () => {
      const resolved = resolveModelRefFromString({
        defaultProvider: "anthropic",
        raw: "openrouter/@preset/kimi-2-5@work",
      });
      expect(resolved?.ref).toEqual({
        model: "@preset/kimi-2-5",
        provider: "openrouter",
      });
    });

    it("strips profile suffix before alias resolution", () => {
      const index = {
        byAlias: new Map([
          ["kimi", { alias: "kimi", ref: { model: "moonshotai/kimi-k2.5", provider: "nvidia" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        aliasIndex: index,
        defaultProvider: "openai",
        raw: "kimi@nvidia:default",
      });
      expect(resolved?.ref).toEqual({
        model: "moonshotai/kimi-k2.5",
        provider: "nvidia",
      });
      expect(resolved?.alias).toBe("kimi");
    });
  });

  describe("resolveConfiguredModelRef", () => {
    it("should infer the unique provider from configured models for bare defaults", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "claude-opus-4-6" },
            models: {
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveConfiguredModelRef({
        cfg,
        defaultModel: "gpt-5.4",
        defaultProvider: "openai",
      });

      expect(result).toEqual({ model: "claude-opus-4-6", provider: "anthropic" });
    });

    it("should fall back to the configured default provider and warn if provider is missing for non-alias", () => {
      setLoggerOverride({ consoleLevel: "warn", level: "silent" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "claude-3-5-sonnet" },
            },
          },
        };

        const result = resolveConfiguredModelRef({
          cfg: cfg as OpenClawConfig,
          defaultModel: "gemini-pro",
          defaultProvider: "google",
        });

        expect(result).toEqual({ model: "claude-3-5-sonnet", provider: "google" });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Falling back to "google/claude-3-5-sonnet"'),
        );
      } finally {
        warnSpy.mockRestore();
        setLoggerOverride(null);
        resetLogger();
      }
    });

    it("sanitizes control characters in providerless-model warnings", () => {
      const warnLogs = createWarnLogCapture("openclaw-model-selection-test");
      try {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "\u001B[31mclaude-3-5-sonnet\nspoof" },
            },
          },
        };

        const result = resolveConfiguredModelRef({
          cfg: cfg as OpenClawConfig,
          defaultModel: "gemini-pro",
          defaultProvider: "google",
        });

        expect(result).toEqual({
          model: "\u001B[31mclaude-3-5-sonnet\nspoof",
          provider: "google",
        });
        const warning = warnLogs.findText('Falling back to "google/claude-3-5-sonnet"');
        expect(warning).toContain('Falling back to "google/claude-3-5-sonnet"');
        expect(warning).not.toContain("\u001B");
        expect(warning).not.toContain("\n");
      } finally {
        warnLogs.cleanup();
      }
    });

    it("infers a unique configured provider for bare default model strings", () => {
      setLoggerOverride({ consoleLevel: "warn", level: "silent" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = {
          agents: {
            defaults: {
              model: { primary: "claude-opus-4-6" },
              models: {
                "anthropic/claude-opus-4-6": {},
              },
            },
          },
        } as OpenClawConfig;

        const result = resolveConfiguredModelRef({
          cfg,
          defaultModel: "gpt-5.4",
          defaultProvider: "openai",
        });

        expect(result).toEqual({ model: "claude-opus-4-6", provider: "anthropic" });
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        setLoggerOverride(null);
        resetLogger();
      }
    });

    it("should use default provider/model if config is empty", () => {
      const cfg: Partial<OpenClawConfig> = {};
      const result = resolveConfiguredModelRef({
        cfg: cfg as OpenClawConfig,
        defaultModel: "gpt-4",
        defaultProvider: "openai",
      });
      expect(result).toEqual({ model: "gpt-4", provider: "openai" });
    });

    it("should prefer configured custom provider when default provider is not in models.providers", () => {
      const cfg = createProviderWithModelsConfig("n1n", [
        {
          contextWindow: 128_000,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
          id: "gpt-5.4",
          input: ["text"],
          maxTokens: 4096,
          name: "GPT 5.4",
          reasoning: false,
        },
      ]);
      const result = resolveConfiguredRefForTest(cfg);
      expect(result).toEqual({ model: "gpt-5.4", provider: "n1n" });
    });

    it("should keep default provider when it is in models.providers", () => {
      const cfg = createProviderWithModelsConfig("anthropic", [
        {
          contextWindow: 200_000,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
          id: "claude-opus-4-6",
          input: ["text", "image"],
          maxTokens: 4096,
          name: "Claude Opus 4.6",
          reasoning: true,
        },
      ]);
      const result = resolveConfiguredRefForTest(cfg);
      expect(result).toEqual({ model: "claude-opus-4-6", provider: "anthropic" });
    });

    it("can skip plugin-backed model normalization for display-only callers", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "google-vertex/gemini-3.1-flash-lite" },
          },
        },
      } as OpenClawConfig;

      const result = resolveConfiguredModelRef({
        allowPluginNormalization: false,
        cfg,
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
      });

      expect(result).toEqual({
        model: "gemini-3.1-flash-lite-preview",
        provider: "google-vertex",
      });
    });

    it("should fall back to hardcoded default when no custom providers have models", () => {
      const cfg = createProviderWithModelsConfig("empty-provider", []);
      const result = resolveConfiguredRefForTest(cfg);
      expect(result).toEqual({ model: "gpt-5.4", provider: "openai" });
    });

    it("should warn when specified model cannot be resolved and falls back to default", () => {
      setLoggerOverride({ consoleLevel: "warn", level: "silent" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "openai/" },
            },
          },
        };

        const result = resolveConfiguredModelRef({
          cfg: cfg as OpenClawConfig,
          defaultModel: "gpt-5.4",
          defaultProvider: "openai",
        });

        expect(result).toEqual({ model: "gpt-5.4", provider: "openai" });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Falling back to default "openai/gpt-5.4"'),
        );
      } finally {
        warnSpy.mockRestore();
        setLoggerOverride(null);
        resetLogger();
      }
    });
  });

  describe("resolveThinkingDefault", () => {
    it("prefers per-model params.thinking over global thinkingDefault", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: { thinking: "high" },
              },
            },
            thinkingDefault: "low",
          },
        },
      } as OpenClawConfig;

      expect(resolveAnthropicOpusThinking(cfg)).toBe("high");
    });

    it("accepts legacy duplicated OpenRouter keys for per-model thinking", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/hunter-alpha": {
                params: { thinking: "high" },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(
        resolveThinkingDefault({
          cfg,
          model: "openrouter/hunter-alpha",
          provider: "openrouter",
        }),
      ).toBe("high");
    });

    it("accepts per-model params.thinking=adaptive", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: { thinking: "adaptive" },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(resolveAnthropicOpusThinking(cfg)).toBe("adaptive");
    });

    it("falls back to low when no provider thinking hook is active", () => {
      const cfg = {} as OpenClawConfig;

      expect(resolveAnthropicOpusThinking(cfg)).toBe("low");

      expect(
        resolveThinkingDefault({
          catalog: [
            {
              id: "us.anthropic.claude-sonnet-4-6-v1:0",
              name: "Claude Sonnet 4.6",
              provider: "amazon-bedrock",
              reasoning: true,
            },
          ],
          cfg,
          model: "us.anthropic.claude-sonnet-4-6-v1:0",
          provider: "amazon-bedrock",
        }),
      ).toBe("low");
    });
  });
});

describe("normalizeModelSelection", () => {
  it("returns trimmed string for string input", () => {
    expect(normalizeModelSelection("ollama/llama3.2:3b")).toBe("ollama/llama3.2:3b");
  });

  it("returns undefined for empty/whitespace string", () => {
    expect(normalizeModelSelection("")).toBeUndefined();
    expect(normalizeModelSelection("   ")).toBeUndefined();
  });

  it("extracts primary from object", () => {
    expect(normalizeModelSelection({ primary: "google/gemini-2.5-flash" })).toBe(
      "google/gemini-2.5-flash",
    );
  });

  it("returns undefined for object without primary", () => {
    expect(normalizeModelSelection({ fallbacks: ["a"] })).toBeUndefined();
    expect(normalizeModelSelection({})).toBeUndefined();
  });

  it("returns undefined for null/undefined/number", () => {
    expect(normalizeModelSelection(undefined)).toBeUndefined();
    expect(normalizeModelSelection(null)).toBeUndefined();
    expect(normalizeModelSelection(42)).toBeUndefined();
  });
});

describe("resolveSubagentConfiguredModelSelection", () => {
  it("prefers the agent primary model over agents.defaults.subagents.model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          subagents: { model: "openai/gpt-5.4" },
        },
        list: [
          {
            id: "research",
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        ],
      },
    } as OpenClawConfig;

    expect(resolveSubagentConfiguredModelSelection({ agentId: "research", cfg })).toBe(
      "anthropic/claude-opus-4-6",
    );
  });

  it("still prefers agent subagents.model over the agent primary model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          subagents: { model: "openai/gpt-5.4" },
        },
        list: [
          {
            id: "research",
            model: { primary: "anthropic/claude-opus-4-6" },
            subagents: { model: "google/gemini-2.5-pro" },
          },
        ],
      },
    } as OpenClawConfig;

    expect(resolveSubagentConfiguredModelSelection({ agentId: "research", cfg })).toBe(
      "google/gemini-2.5-pro",
    );
  });
});
