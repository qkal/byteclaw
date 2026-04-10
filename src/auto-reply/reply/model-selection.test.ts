import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_CONTEXT_TOKEN_CACHE } from "../../agents/context-cache.js";
import { loadModelCatalog } from "../../agents/model-catalog.runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createModelSelectionState, resolveContextTokens } from "./model-selection.js";

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { id: "claude-opus-4-6", name: "Claude Opus 4.5", provider: "anthropic" },
    { id: "deepseek-v3-4bit-mlx", name: "DeepSeek V3", provider: "inferencer" },
    { id: "kimi-code", name: "Kimi Code", provider: "kimi" },
    { id: "gpt-4o-mini", name: "GPT-4o mini", provider: "openai" },
    { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
    { id: "grok-4", name: "Grok 4", provider: "xai" },
    { id: "grok-4.20-reasoning", name: "Grok 4.20 (Reasoning)", provider: "xai" },
  ]),
}));

vi.mock("../../channels/plugins/session-conversation.js", () => ({
  resolveSessionParentSessionKey: (sessionKey?: string) =>
    sessionKey?.replace(/:thread:[^:]+$/, "").replace(/:topic:[^:]+$/, "") ?? null,
}));

afterEach(() => {
  MODEL_CONTEXT_TOKEN_CACHE.clear();
});

const makeConfiguredModel = (overrides: Record<string, unknown> = {}) => ({
  contextWindow: 128_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "gpt-5.4",
  input: ["text"],
  maxTokens: 16_384,
  name: "GPT-5.4",
  reasoning: true,
  ...overrides,
});

describe("createModelSelectionState catalog loading", () => {
  it("skips full catalog loading for ordinary allowlist-backed turns", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {},
          },
          thinkingDefault: "low",
        },
      },
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel()],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      agentCfg: cfg.agents?.defaults,
      cfg,
      defaultModel: "gpt-5.4",
      defaultProvider: "openai-codex",
      hasModelDirective: false,
      model: "gpt-5.4",
      provider: "openai-codex",
    });

    expect(state.allowedModelKeys.has("openai-codex/gpt-5.4")).toBe(true);
    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("low");
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("prefers per-agent thinkingDefault over model and global defaults", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: { thinking: "high" },
            },
          },
          thinkingDefault: "low",
        },
        list: [
          {
            id: "alpha",
            thinkingDefault: "minimal",
          },
        ],
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      agentCfg: cfg.agents?.defaults,
      agentId: "alpha",
      cfg,
      defaultModel: "gpt-5.4",
      defaultProvider: "openai-codex",
      hasModelDirective: false,
      model: "gpt-5.4",
      provider: "openai-codex",
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("minimal");
  });

  it("loads the full catalog for explicit model directives", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o": {},
          },
        },
      },
    } as OpenClawConfig;

    await createModelSelectionState({
      agentCfg: cfg.agents?.defaults,
      cfg,
      defaultModel: "gpt-4o",
      defaultProvider: "openai",
      hasModelDirective: true,
      model: "gpt-4o",
      provider: "openai",
    });

    expect(loadModelCatalog).toHaveBeenCalledOnce();
  });
});

describe("resolveContextTokens", () => {
  it("prefers provider-qualified cache keys over bare model ids", () => {
    MODEL_CONTEXT_TOKEN_CACHE.set("claude-opus-4-6", 200_000);
    MODEL_CONTEXT_TOKEN_CACHE.set("anthropic/claude-opus-4-6", 1_000_000);

    const result = resolveContextTokens({
      agentCfg: undefined,
      cfg: {} as OpenClawConfig,
      model: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(result).toBe(1_000_000);
  });
});

const makeEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "session-id",
  updatedAt: Date.now(),
  ...overrides,
});

describe("createModelSelectionState parent inheritance", () => {
  const defaultProvider = "openai";
  const defaultModel = "gpt-4o-mini";

  async function resolveState(params: {
    cfg: OpenClawConfig;
    sessionEntry: ReturnType<typeof makeEntry>;
    sessionStore: Record<string, ReturnType<typeof makeEntry>>;
    sessionKey: string;
    parentSessionKey?: string;
  }) {
    return createModelSelectionState({
      agentCfg: params.cfg.agents?.defaults,
      cfg: params.cfg,
      defaultModel,
      defaultProvider,
      hasModelDirective: false,
      model: defaultModel,
      parentSessionKey: params.parentSessionKey,
      provider: defaultProvider,
      sessionEntry: params.sessionEntry,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
    });
  }

  async function resolveHeartbeatStoredOverrideState(hasResolvedHeartbeatModelOverride: boolean) {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:discord:channel:c1";
    const sessionEntry = makeEntry({
      modelOverride: "gpt-4o",
      providerOverride: "openai",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    return createModelSelectionState({
      agentCfg: cfg.agents?.defaults,
      cfg,
      defaultModel,
      defaultProvider,
      hasModelDirective: false,
      hasResolvedHeartbeatModelOverride,
      model: "claude-opus-4-6",
      provider: "anthropic",
      sessionEntry,
      sessionKey,
      sessionStore,
    });
  }

  async function resolveStateWithParent(params: {
    cfg: OpenClawConfig;
    parentKey: string;
    sessionKey: string;
    parentEntry: ReturnType<typeof makeEntry>;
    sessionEntry?: ReturnType<typeof makeEntry>;
    parentSessionKey?: string;
  }) {
    const sessionEntry = params.sessionEntry ?? makeEntry();
    const sessionStore = {
      [params.parentKey]: params.parentEntry,
      [params.sessionKey]: sessionEntry,
    };
    return resolveState({
      cfg: params.cfg,
      parentSessionKey: params.parentSessionKey,
      sessionEntry,
      sessionKey: params.sessionKey,
      sessionStore,
    });
  }

  it("inherits parent override from explicit parentSessionKey", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:discord:channel:c1";
    const sessionKey = "agent:main:discord:channel:c1:thread:123";
    const parentEntry = makeEntry({
      modelOverride: "gpt-4o",
      providerOverride: "openai",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentEntry,
      parentKey,
      parentSessionKey: parentKey,
      sessionKey,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("derives parent key from topic session suffix", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:telegram:group:123";
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const parentEntry = makeEntry({
      modelOverride: "gpt-4o",
      providerOverride: "openai",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentEntry,
      parentKey,
      sessionKey,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("prefers child override over parent", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:telegram:group:123";
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const parentEntry = makeEntry({
      modelOverride: "gpt-4o",
      providerOverride: "openai",
    });
    const sessionEntry = makeEntry({
      modelOverride: "claude-opus-4-6",
      providerOverride: "anthropic",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentEntry,
      parentKey,
      sessionEntry,
      sessionKey,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-6");
  });

  it("ignores parent override when disallowed", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o-mini": {},
          },
        },
      },
    } as OpenClawConfig;
    const parentKey = "agent:main:slack:channel:c1";
    const sessionKey = "agent:main:slack:channel:c1:thread:123";
    const parentEntry = makeEntry({
      modelOverride: "claude-opus-4-6",
      providerOverride: "anthropic",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentEntry,
      parentKey,
      sessionKey,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
  });

  it("applies stored override when heartbeat override was not resolved", async () => {
    const state = await resolveHeartbeatStoredOverrideState(false);

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("skips stored override when heartbeat override was resolved", async () => {
    const state = await resolveHeartbeatStoredOverrideState(true);

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-6");
  });
});

describe("createModelSelectionState respects session model override", () => {
  const defaultProvider = "inferencer";
  const defaultModel = "deepseek-v3-4bit-mlx";

  async function resolveState(sessionEntry: ReturnType<typeof makeEntry>) {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:main";
    const sessionStore = { [sessionKey]: sessionEntry };

    return createModelSelectionState({
      agentCfg: undefined,
      cfg,
      defaultModel,
      defaultProvider,
      hasModelDirective: false,
      model: defaultModel,
      provider: defaultProvider,
      sessionEntry,
      sessionKey,
      sessionStore,
    });
  }

  it("applies session modelOverride when set", async () => {
    const state = await resolveState(
      makeEntry({
        modelOverride: "kimi-code",
        providerOverride: "kimi-coding",
      }),
    );

    expect(state.provider).toBe("kimi");
    expect(state.model).toBe("kimi-code");
  });

  it("falls back to default when no modelOverride is set", async () => {
    const state = await resolveState(makeEntry());

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
  });

  it("respects modelOverride even when session model field differs", async () => {
    // From issue #14783: stored override should beat last-used fallback model.
    const state = await resolveState(
      makeEntry({
        contextTokens: 262_000,
        model: "kimi-code",
        modelOverride: "claude-opus-4-6",
        modelProvider: "kimi",
        providerOverride: "anthropic",
      }),
    );

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-6");
  });

  it("uses default provider when providerOverride is not set but modelOverride is", async () => {
    const state = await resolveState(
      makeEntry({
        modelOverride: "deepseek-v3-4bit-mlx",
      }),
    );

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe("deepseek-v3-4bit-mlx");
  });

  it("splits legacy combined modelOverride when providerOverride is missing", async () => {
    const state = await resolveState(
      makeEntry({
        modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
      }),
    );

    expect(state.provider).toBe("ollama-beelink2");
    expect(state.model).toBe("qwen2.5-coder:7b");
  });

  it("normalizes deprecated xai beta session overrides before allowlist checks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "xai/grok-4",
          },
          models: {
            "xai/grok-4": {},
            "xai/grok-4.20-experimental-beta-0304-reasoning": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const sessionEntry = makeEntry({
      modelOverride: "grok-4.20-experimental-beta-0304-reasoning",
      providerOverride: "xai",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentCfg: cfg.agents?.defaults,
      cfg,
      defaultModel: "grok-4",
      defaultProvider: "xai",
      hasModelDirective: false,
      model: "grok-4",
      provider: "xai",
      sessionEntry,
      sessionKey,
      sessionStore,
    });

    expect(state.provider).toBe("xai");
    expect(state.model).toBe("grok-4.20-beta-latest-reasoning");
    expect(state.resetModelOverride).toBe(false);
  });

  it("clears disallowed model overrides and falls back to the default", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-4o" },
          models: {
            "openai/gpt-4o": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      modelOverride: "gpt-4o-mini",
      providerOverride: "openai",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentCfg: cfg.agents?.defaults,
      cfg,
      defaultModel: "gpt-4o",
      defaultProvider: "openai",
      hasModelDirective: false,
      model: "gpt-4o",
      provider: "openai",
      sessionEntry,
      sessionKey,
      sessionStore,
    });

    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
  });

  it("keeps allowed legacy combined session overrides after normalization", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: {
            "anthropic/claude-opus-4-6": {},
            "ollama-beelink2/qwen2.5-coder:7b": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:2";
    const sessionEntry = makeEntry({
      modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentCfg: cfg.agents?.defaults,
      cfg,
      defaultModel: "claude-opus-4-6",
      defaultProvider: "anthropic",
      hasModelDirective: false,
      model: "claude-opus-4-6",
      provider: "anthropic",
      sessionEntry,
      sessionKey,
      sessionStore,
    });

    expect(state.provider).toBe("ollama-beelink2");
    expect(state.model).toBe("qwen2.5-coder:7b");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.modelOverride).toBe("ollama-beelink2/qwen2.5-coder:7b");
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
  });
});

describe("createModelSelectionState resolveDefaultReasoningLevel", () => {
  it("returns on when catalog model has reasoning true", async () => {
    const { loadModelCatalog } = await import("../../agents/model-catalog.runtime.js");
    vi.mocked(loadModelCatalog).mockResolvedValueOnce([
      { id: "x-ai/grok-4.1-fast", name: "Grok", provider: "openrouter", reasoning: true },
    ]);
    const state = await createModelSelectionState({
      agentCfg: undefined,
      cfg: {} as OpenClawConfig,
      defaultModel: "x-ai/grok-4.1-fast",
      defaultProvider: "openrouter",
      hasModelDirective: false,
      model: "x-ai/grok-4.1-fast",
      provider: "openrouter",
    });
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
  });

  it("returns off when catalog model has no reasoning", async () => {
    const state = await createModelSelectionState({
      agentCfg: undefined,
      cfg: {} as OpenClawConfig,
      defaultModel: "gpt-4o-mini",
      defaultProvider: "openai",
      hasModelDirective: false,
      model: "gpt-4o-mini",
      provider: "openai",
    });
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("off");
  });
});
