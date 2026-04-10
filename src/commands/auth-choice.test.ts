import fs from "node:fs/promises";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
import { providerApiKeyAuthRuntime } from "../plugins/provider-api-key-auth.runtime.js";
import type { ProviderAuthMethod, ProviderAuthResult, ProviderPlugin } from "../plugins/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import type { AuthChoice } from "./onboard-types.js";
import {
  authProfilePathForAgent,
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  requireOpenClawAgentDir,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

type DetectZaiEndpoint = typeof import("../plugins/provider-zai-endpoint.js").detectZaiEndpoint;

const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const MINIMAX_CN_API_BASE_URL = "https://api.minimax.chat/v1";
const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";

const loginOpenAICodexOAuth = vi.hoisted(() =>
  vi.fn<() => Promise<OAuthCredentials | null>>(async () => null),
);
vi.mock("../plugins/provider-openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth,
}));

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../plugins/provider-auth-choice.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-auth-choice.runtime.js")>(
    "../plugins/provider-auth-choice.runtime.js",
  );
  return {
    ...actual,
    resolvePluginProviders,
    runProviderModelSelectedHook,
  };
});

const detectZaiEndpoint = vi.hoisted(() => vi.fn<DetectZaiEndpoint>(async () => null));
vi.mock("../plugins/provider-zai-endpoint.js", () => ({
  detectZaiEndpoint,
}));

interface StoredAuthProfile {
  key?: string;
  token?: string;
  keyRef?: { source: string; provider: string; id: string };
  access?: string;
  refresh?: string;
  provider?: string;
  type?: string;
  email?: string;
  metadata?: Record<string, string>;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerConfigPatch(
  providerId: string,
  patch: Record<string, unknown>,
): Partial<OpenClawConfig> {
  const providers: Record<string, ModelProviderConfig> = {
    [providerId]: patch as ModelProviderConfig,
  };
  return {
    models: {
      providers,
    },
  };
}

function createApiKeyProvider(params: {
  providerId: string;
  label: string;
  choiceId: string;
  optionKey: string;
  flagName: `--${string}`;
  envVar: string;
  promptMessage: string;
  defaultModel?: string;
  profileId?: string;
  profileIds?: string[];
  expectedProviders?: string[];
  noteMessage?: string;
  noteTitle?: string;
  applyConfig?: Partial<OpenClawConfig>;
}): ProviderPlugin {
  return {
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: params.providerId,
        methodId: "api-key",
        label: params.label,
        optionKey: params.optionKey,
        flagName: params.flagName,
        envVar: params.envVar,
        promptMessage: params.promptMessage,
        ...(params.profileId ? { profileId: params.profileId } : {}),
        ...(params.profileIds ? { profileIds: params.profileIds } : {}),
        ...(params.defaultModel ? { defaultModel: params.defaultModel } : {}),
        ...(params.expectedProviders ? { expectedProviders: params.expectedProviders } : {}),
        ...(params.noteMessage ? { noteMessage: params.noteMessage } : {}),
        ...(params.noteTitle ? { noteTitle: params.noteTitle } : {}),
        ...(params.applyConfig ? { applyConfig: () => params.applyConfig as OpenClawConfig } : {}),
        wizard: {
          choiceId: params.choiceId,
          choiceLabel: params.label,
          groupId: params.providerId,
          groupLabel: params.label,
        },
      }),
    ],
    id: params.providerId,
    label: params.label,
  };
}

function createFixedChoiceProvider(params: {
  providerId: string;
  label: string;
  choiceId: string;
  method: ProviderAuthMethod;
}): ProviderPlugin {
  return {
    auth: [
      {
        ...params.method,
        wizard: {
          choiceId: params.choiceId,
          choiceLabel: params.label,
          groupId: params.providerId,
          groupLabel: params.label,
        },
      },
    ],
    id: params.providerId,
    label: params.label,
  };
}

function createDefaultProviderPlugins() {
  const {buildApiKeyCredential} = providerApiKeyAuthRuntime;
  const {ensureApiKeyFromOptionEnvOrPrompt} = providerApiKeyAuthRuntime;
  const {normalizeApiKeyInput} = providerApiKeyAuthRuntime;
  const {validateApiKeyInput} = providerApiKeyAuthRuntime;

  const createZaiMethod = (choiceId: "zai-api-key" | "zai-coding-global"): ProviderAuthMethod => ({
    id: choiceId === "zai-api-key" ? "api-key" : "coding-global",
    kind: "api_key",
    label: "Z.AI API key",
    run: async (ctx) => {
      const token = normalizeText(await ctx.prompter.text({ message: "Enter Z.AI API key" }));
      const detectResult = await detectZaiEndpoint(
        choiceId === "zai-coding-global"
          ? { apiKey: token, endpoint: "coding-global" }
          : { apiKey: token },
      );
      let baseUrl = detectResult?.baseUrl;
      let modelId = detectResult?.modelId;
      if (!baseUrl || !modelId) {
        if (choiceId === "zai-coding-global") {
          baseUrl = ZAI_CODING_GLOBAL_BASE_URL;
          modelId = "glm-5";
        } else {
          const endpoint = await ctx.prompter.select({
            initialValue: "global",
            message: "Select Z.AI endpoint",
            options: [
              { label: "Global", value: "global" },
              { label: "Coding CN", value: "coding-cn" },
            ],
          });
          baseUrl = endpoint === "coding-cn" ? ZAI_CODING_CN_BASE_URL : ZAI_CODING_GLOBAL_BASE_URL;
          modelId = "glm-5";
        }
      }
      return {
        configPatch: providerConfigPatch("zai", { baseUrl }) as OpenClawConfig,
        defaultModel: `zai/${modelId}`,
        profiles: [
          {
            profileId: "zai:default",
            credential: buildApiKeyCredential("zai", token),
          },
        ],
      };
    },
    wizard: {
      choiceId,
      choiceLabel: "Z.AI API key",
      groupId: "zai",
      groupLabel: "Z.AI",
    },
  });

  const cloudflareAiGatewayMethod: ProviderAuthMethod = {
    id: "api-key",
    kind: "api_key",
    label: "Cloudflare AI Gateway API key",
    run: async (ctx) => {
      const opts = (ctx.opts ?? {}) as Record<string, unknown>;
      const accountId =
        normalizeText(opts.cloudflareAiGatewayAccountId) ||
        normalizeText(await ctx.prompter.text({ message: "Enter Cloudflare account ID" }));
      const gatewayId =
        normalizeText(opts.cloudflareAiGatewayGatewayId) ||
        normalizeText(await ctx.prompter.text({ message: "Enter Cloudflare gateway ID" }));
      let capturedSecretInput = "";
      let capturedMode: "plaintext" | "ref" | undefined;
      await ensureApiKeyFromOptionEnvOrPrompt({
        config: ctx.config,
        envLabel: "CLOUDFLARE_AI_GATEWAY_API_KEY",
        expectedProviders: ["cloudflare-ai-gateway"],
        normalize: normalizeApiKeyInput,
        promptMessage: "Enter Cloudflare AI Gateway API key",
        prompter: ctx.prompter,
        provider: "cloudflare-ai-gateway",
        secretInputMode:
          ctx.allowSecretRefPrompt === false
            ? (ctx.secretInputMode ?? "plaintext")
            : ctx.secretInputMode,
        setCredential: async (apiKey, mode) => {
          capturedSecretInput = typeof apiKey === "string" ? apiKey : "";
          capturedMode = mode;
        },
        token:
          normalizeText(opts.cloudflareAiGatewayApiKey) ||
          normalizeText(ctx.opts?.token) ||
          undefined,
        tokenProvider: "cloudflare-ai-gateway",
        validate: validateApiKeyInput,
      });
      return {
        defaultModel: "cloudflare-ai-gateway/claude-sonnet-4-5",
        profiles: [
          {
            profileId: "cloudflare-ai-gateway:default",
            credential: buildApiKeyCredential(
              "cloudflare-ai-gateway",
              capturedSecretInput,
              { accountId, gatewayId },
              capturedMode ? { secretInputMode: capturedMode } : undefined,
            ),
          },
        ],
      };
    },
    wizard: {
      choiceId: "cloudflare-ai-gateway-api-key",
      choiceLabel: "Cloudflare AI Gateway API key",
      groupId: "cloudflare-ai-gateway",
      groupLabel: "Cloudflare AI Gateway",
    },
  };

  const chutesOAuthMethod: ProviderAuthMethod = {
    id: "oauth",
    kind: "device_code",
    label: "Chutes OAuth",
    run: async (ctx) => {
      const state = "state-test";
      ctx.runtime.log(`Open this URL: https://api.chutes.ai/idp/authorize?state=${state}`);
      const redirect = String(
        await ctx.prompter.text({ message: "Paste the redirect URL or code" }),
      );
      const params = new URLSearchParams(redirect.startsWith("?") ? redirect.slice(1) : redirect);
      const code = params.get("code") ?? redirect;
      const tokenResponse = await fetch("https://api.chutes.ai/idp/token", {
        body: JSON.stringify({ code, client_id: process.env.CHUTES_CLIENT_ID }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const tokenJson = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      const userResponse = await fetch("https://api.chutes.ai/idp/userinfo", {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const userJson = (await userResponse.json()) as { username: string };
      return {
        profiles: [
          {
            credential: {
              access: tokenJson.access_token,
              email: userJson.username,
              expires: Date.now() + tokenJson.expires_in * 1000,
              provider: "chutes",
              refresh: tokenJson.refresh_token,
              type: "oauth",
            },
            profileId: `chutes:${userJson.username}`,
          },
        ],
      };
    },
    wizard: {
      choiceId: "chutes",
      choiceLabel: "Chutes",
      groupId: "chutes",
      groupLabel: "Chutes",
    },
  };

  return [
    createApiKeyProvider({
      choiceId: "apiKey",
      envVar: "ANTHROPIC_API_KEY",
      flagName: "--anthropic-api-key",
      label: "Anthropic API key",
      optionKey: "anthropicApiKey",
      promptMessage: "Enter Anthropic API key",
      providerId: "anthropic",
    }),
    createApiKeyProvider({
      choiceId: "gemini-api-key",
      defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
      envVar: "GEMINI_API_KEY",
      flagName: "--gemini-api-key",
      label: "Gemini API key",
      optionKey: "geminiApiKey",
      promptMessage: "Enter Gemini API key",
      providerId: "google",
    }),
    createApiKeyProvider({
      choiceId: "huggingface-api-key",
      defaultModel: "huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct",
      envVar: "HUGGINGFACE_HUB_TOKEN",
      flagName: "--huggingface-api-key",
      label: "Hugging Face API key",
      optionKey: "huggingfaceApiKey",
      promptMessage: "Enter Hugging Face API key",
      providerId: "huggingface",
    }),
    createApiKeyProvider({
      choiceId: "litellm-api-key",
      defaultModel: "litellm/anthropic/claude-opus-4.6",
      envVar: "LITELLM_API_KEY",
      flagName: "--litellm-api-key",
      label: "LiteLLM API key",
      optionKey: "litellmApiKey",
      promptMessage: "Enter LiteLLM API key",
      providerId: "litellm",
    }),
    createApiKeyProvider({
      choiceId: "minimax-global-api",
      defaultModel: "minimax/MiniMax-M2.7",
      envVar: "MINIMAX_API_KEY",
      flagName: "--minimax-api-key",
      label: "MiniMax API key (Global)",
      optionKey: "minimaxApiKey",
      profileId: "minimax:global",
      promptMessage: "Enter MiniMax API key",
      providerId: "minimax",
    }),
    createApiKeyProvider({
      applyConfig: providerConfigPatch("minimax", { baseUrl: MINIMAX_CN_API_BASE_URL }),
      choiceId: "minimax-cn-api",
      defaultModel: "minimax/MiniMax-M2.7",
      envVar: "MINIMAX_API_KEY",
      expectedProviders: ["minimax", "minimax-cn"],
      flagName: "--minimax-api-key",
      label: "MiniMax API key (CN)",
      optionKey: "minimaxApiKey",
      profileId: "minimax:cn",
      promptMessage: "Enter MiniMax CN API key",
      providerId: "minimax",
    }),
    createApiKeyProvider({
      choiceId: "mistral-api-key",
      defaultModel: "mistral/mistral-large-latest",
      envVar: "MISTRAL_API_KEY",
      flagName: "--mistral-api-key",
      label: "Mistral API key",
      optionKey: "mistralApiKey",
      promptMessage: "Enter Mistral API key",
      providerId: "mistral",
    }),
    createApiKeyProvider({
      choiceId: "moonshot-api-key",
      defaultModel: "moonshot/moonshot-v1-128k",
      envVar: "MOONSHOT_API_KEY",
      flagName: "--moonshot-api-key",
      label: "Moonshot API key",
      optionKey: "moonshotApiKey",
      promptMessage: "Enter Moonshot API key",
      providerId: "moonshot",
    }),
    createFixedChoiceProvider({
      choiceId: "ollama",
      label: "Ollama",
      method: {
        id: "local",
        kind: "custom",
        label: "Ollama",
        run: async () => ({ profiles: [] }),
      },
      providerId: "ollama",
    }),
    createApiKeyProvider({
      choiceId: "openai-api-key",
      defaultModel: "openai/gpt-5.4",
      envVar: "OPENAI_API_KEY",
      flagName: "--openai-api-key",
      label: "OpenAI API key",
      optionKey: "openaiApiKey",
      promptMessage: "Enter OpenAI API key",
      providerId: "openai",
    }),
    createApiKeyProvider({
      choiceId: "opencode-zen",
      defaultModel: "opencode/claude-opus-4-6",
      envVar: "OPENCODE_API_KEY",
      expectedProviders: ["opencode", "opencode-go"],
      flagName: "--opencode-zen-api-key",
      label: "OpenCode Zen",
      noteMessage: "OpenCode uses one API key across the Zen and Go catalogs.",
      noteTitle: "OpenCode",
      optionKey: "opencodeZenApiKey",
      profileIds: ["opencode:default", "opencode-go:default"],
      promptMessage: "Enter OpenCode API key",
      providerId: "opencode",
    }),
    createApiKeyProvider({
      choiceId: "opencode-go",
      defaultModel: "opencode-go/kimi-k2.5",
      envVar: "OPENCODE_API_KEY",
      expectedProviders: ["opencode", "opencode-go"],
      flagName: "--opencode-go-api-key",
      label: "OpenCode Go",
      noteMessage: "OpenCode uses one API key across the Zen and Go catalogs.",
      noteTitle: "OpenCode",
      optionKey: "opencodeGoApiKey",
      profileIds: ["opencode-go:default", "opencode:default"],
      promptMessage: "Enter OpenCode API key",
      providerId: "opencode-go",
    }),
    createApiKeyProvider({
      choiceId: "openrouter-api-key",
      defaultModel: "openrouter/auto",
      envVar: "OPENROUTER_API_KEY",
      flagName: "--openrouter-api-key",
      label: "OpenRouter API key",
      optionKey: "openrouterApiKey",
      promptMessage: "Enter OpenRouter API key",
      providerId: "openrouter",
    }),
    createApiKeyProvider({
      choiceId: "qianfan-api-key",
      defaultModel: "qianfan/ernie-4.5-8k",
      envVar: "QIANFAN_API_KEY",
      flagName: "--qianfan-api-key",
      label: "Qianfan API key",
      optionKey: "qianfanApiKey",
      promptMessage: "Enter Qianfan API key",
      providerId: "qianfan",
    }),
    createApiKeyProvider({
      choiceId: "synthetic-api-key",
      defaultModel: "synthetic/Synthetic-1",
      envVar: "SYNTHETIC_API_KEY",
      flagName: "--synthetic-api-key",
      label: "Synthetic API key",
      optionKey: "syntheticApiKey",
      promptMessage: "Enter Synthetic API key",
      providerId: "synthetic",
    }),
    createApiKeyProvider({
      choiceId: "together-api-key",
      defaultModel: "together/meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
      envVar: "TOGETHER_API_KEY",
      flagName: "--together-api-key",
      label: "Together API key",
      optionKey: "togetherApiKey",
      promptMessage: "Enter Together API key",
      providerId: "together",
    }),
    createApiKeyProvider({
      choiceId: "venice-api-key",
      defaultModel: "venice/venice-uncensored",
      envVar: "VENICE_API_KEY",
      flagName: "--venice-api-key",
      label: "Venice AI",
      noteMessage: "Venice is a privacy-focused inference service.",
      noteTitle: "Venice AI",
      optionKey: "veniceApiKey",
      promptMessage: "Enter Venice AI API key",
      providerId: "venice",
    }),
    createApiKeyProvider({
      choiceId: "ai-gateway-api-key",
      defaultModel: "vercel-ai-gateway/anthropic/claude-opus-4.6",
      envVar: "AI_GATEWAY_API_KEY",
      flagName: "--ai-gateway-api-key",
      label: "AI Gateway API key",
      optionKey: "aiGatewayApiKey",
      promptMessage: "Enter AI Gateway API key",
      providerId: "vercel-ai-gateway",
    }),
    createApiKeyProvider({
      choiceId: "xai-api-key",
      defaultModel: "xai/grok-4",
      envVar: "XAI_API_KEY",
      flagName: "--xai-api-key",
      label: "xAI API key",
      optionKey: "xaiApiKey",
      promptMessage: "Enter xAI API key",
      providerId: "xai",
    }),
    createApiKeyProvider({
      choiceId: "xiaomi-api-key",
      defaultModel: "xiaomi/mimo-v2-flash",
      envVar: "XIAOMI_API_KEY",
      flagName: "--xiaomi-api-key",
      label: "Xiaomi API key",
      optionKey: "xiaomiApiKey",
      promptMessage: "Enter Xiaomi API key",
      providerId: "xiaomi",
    }),
    {
      auth: [createZaiMethod("zai-api-key"), createZaiMethod("zai-coding-global")],
      id: "zai",
      label: "Z.AI",
    },
    {
      auth: [cloudflareAiGatewayMethod],
      id: "cloudflare-ai-gateway",
      label: "Cloudflare AI Gateway",
    },
    {
      auth: [chutesOAuthMethod],
      id: "chutes",
      label: "Chutes",
    },
    createApiKeyProvider({
      choiceId: "kimi-code-api-key",
      defaultModel: "kimi/kimi-k2.5",
      envVar: "KIMI_API_KEY",
      expectedProviders: ["kimi", "kimi-code", "kimi-coding"],
      flagName: "--kimi-api-key",
      label: "Kimi Code API key",
      optionKey: "kimiApiKey",
      promptMessage: "Enter Kimi Code API key",
      providerId: "kimi",
    }),
    createFixedChoiceProvider({
      choiceId: "github-copilot",
      label: "GitHub Copilot",
      method: {
        id: "device",
        kind: "device_code",
        label: "GitHub device login",
        run: async () => ({ profiles: [] }),
      },
      providerId: "github-copilot",
    }),
  ];
}

describe("applyAuthChoice", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "LITELLM_API_KEY",
    "AI_GATEWAY_API_KEY",
    "CLOUDFLARE_AI_GATEWAY_API_KEY",
    "MOONSHOT_API_KEY",
    "MISTRAL_API_KEY",
    "KIMI_API_KEY",
    "GEMINI_API_KEY",
    "XIAOMI_API_KEY",
    "VENICE_API_KEY",
    "OPENCODE_API_KEY",
    "TOGETHER_API_KEY",
    "QIANFAN_API_KEY",
    "SYNTHETIC_API_KEY",
    "SSH_TTY",
    "CHUTES_CLIENT_ID",
  ]);
  let activeStateDir: string | null = null;
  async function setupTempState() {
    if (activeStateDir) {
      await fs.rm(activeStateDir, { force: true, recursive: true });
    }
    const env = await setupAuthTestEnv("openclaw-auth-");
    activeStateDir = env.stateDir;
    lifecycle.setStateDir(env.stateDir);
  }
  function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
    return createWizardPrompter(overrides, { defaultSelect: "" });
  }
  function createSelectFirstOption(): WizardPrompter["select"] {
    return vi.fn(async (params) => params.options[0]?.value as never);
  }
  function createNoopMultiselect(): WizardPrompter["multiselect"] {
    return vi.fn(async () => []);
  }
  function createApiKeyPromptHarness(
    overrides: Partial<Pick<WizardPrompter, "select" | "multiselect" | "text" | "confirm">> = {},
  ): {
    select: WizardPrompter["select"];
    multiselect: WizardPrompter["multiselect"];
    prompter: WizardPrompter;
    runtime: ReturnType<typeof createExitThrowingRuntime>;
  } {
    const select = overrides.select ?? createSelectFirstOption();
    const multiselect = overrides.multiselect ?? createNoopMultiselect();
    return {
      multiselect,
      prompter: createPrompter({ ...overrides, multiselect, select }),
      runtime: createExitThrowingRuntime(),
      select,
    };
  }
  async function readAuthProfiles() {
    return await readAuthProfilesForAgent<{
      profiles?: Record<string, StoredAuthProfile>;
    }>(requireOpenClawAgentDir());
  }
  async function readAuthProfile(profileId: string) {
    return (await readAuthProfiles()).profiles?.[profileId];
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    resolvePluginProviders.mockReset();
    resolvePluginProviders.mockReturnValue(createDefaultProviderPlugins());
    runProviderModelSelectedHook.mockClear();
    detectZaiEndpoint.mockReset();
    detectZaiEndpoint.mockResolvedValue(null);
    loginOpenAICodexOAuth.mockReset();
    loginOpenAICodexOAuth.mockResolvedValue(null);
    await lifecycle.cleanup();
    activeStateDir = null;
  });

  resolvePluginProviders.mockReturnValue(createDefaultProviderPlugins());

  it("applies Anthropic setup-token auth when the provider exposes the setup flow", async () => {
    await setupTempState();

    resolvePluginProviders.mockReturnValue([
      createFixedChoiceProvider({
        choiceId: "setup-token",
        label: "Anthropic",
        method: {
          id: "setup-token",
          kind: "token",
          label: "Anthropic setup-token",
          run: vi.fn(
            async (): Promise<ProviderAuthResult> => ({
              defaultModel: "anthropic/claude-sonnet-4-6",
              profiles: [
                {
                  profileId: "anthropic:default",
                  credential: {
                    type: "token",
                    provider: "anthropic",
                    token: `sk-ant-oat01-${"a".repeat(80)}`,
                  },
                },
              ],
            }),
          ),
        },
        providerId: "anthropic",
      }),
    ]);

    const result = await applyAuthChoice({
      authChoice: "token",
      config: {} as OpenClawConfig,
      opts: {
        token: `sk-ant-oat01-${"a".repeat(80)}`,
        tokenProvider: "anthropic",
      },
      prompter: createPrompter({}),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
    });

    expect(result.config.auth?.profiles?.["anthropic:default"]).toMatchObject({
      mode: "token",
      provider: "anthropic",
    });
    expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect((await readAuthProfile("anthropic:default"))?.token).toBe(
      `sk-ant-oat01-${"a".repeat(80)}`,
    );
  });

  it("does not throw when openai-codex oauth fails", async () => {
    await setupTempState();

    loginOpenAICodexOAuth.mockRejectedValueOnce(new Error("oauth failed"));
    resolvePluginProviders.mockReturnValue([
      {
        auth: [
          {
            id: "oauth",
            kind: "oauth",
            label: "ChatGPT OAuth",
            run: vi.fn(async () => {
              try {
                await loginOpenAICodexOAuth();
              } catch {
                return { profiles: [] };
              }
              return { profiles: [] };
            }),
          },
        ],
        id: "openai-codex",
        label: "OpenAI Codex",
      },
    ] as never);

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    await expect(
      applyAuthChoice({
        authChoice: "openai-codex",
        config: {},
        prompter,
        runtime,
        setDefaultModel: false,
      }),
    ).resolves.toEqual({ config: {} });
  });

  it("stores openai-codex OAuth with email profile id", async () => {
    await setupTempState();

    loginOpenAICodexOAuth.mockResolvedValueOnce({
      access: "access-token",
      email: "user@example.com",
      expires: Date.now() + 60_000,
      refresh: "refresh-token",
    });
    resolvePluginProviders.mockReturnValue([
      {
        auth: [
          {
            id: "oauth",
            kind: "oauth",
            label: "ChatGPT OAuth",
            run: vi.fn(async () => {
              const creds = await loginOpenAICodexOAuth();
              if (!creds) {
                return { profiles: [] };
              }
              return {
                profiles: [
                  {
                    profileId: "openai-codex:user@example.com",
                    credential: {
                      type: "oauth",
                      provider: "openai-codex",
                      refresh: "refresh-token",
                      access: "access-token",
                      expires: creds.expires,
                      email: "user@example.com",
                    },
                  },
                ],
                defaultModel: "openai-codex/gpt-5.4",
              };
            }),
          },
        ],
        id: "openai-codex",
        label: "OpenAI Codex",
      },
    ] as never);

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "openai-codex",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(result.config.auth?.profiles?.["openai-codex:user@example.com"]).toMatchObject({
      mode: "oauth",
      provider: "openai-codex",
    });
    expect(result.config.auth?.profiles?.["openai-codex:default"]).toBeUndefined();
    expect(await readAuthProfile("openai-codex:user@example.com")).toMatchObject({
      access: "access-token",
      email: "user@example.com",
      provider: "openai-codex",
      refresh: "refresh-token",
      type: "oauth",
    });
  });

  it("prompts and writes provider API key profiles for common providers", async () => {
    const scenarios: {
      authChoice:
        | "minimax-global-api"
        | "minimax-cn-api"
        | "synthetic-api-key"
        | "huggingface-api-key";
      promptContains: string;
      profileId: string;
      provider: string;
      token: string;
    }[] = [
      {
        authChoice: "minimax-global-api" as const,
        profileId: "minimax:global",
        promptContains: "Enter MiniMax API key",
        provider: "minimax",
        token: "sk-minimax-test",
      },
      {
        authChoice: "minimax-cn-api" as const,
        profileId: "minimax:cn",
        promptContains: "Enter MiniMax CN API key",
        provider: "minimax",
        token: "sk-minimax-test",
      },
      {
        authChoice: "synthetic-api-key" as const,
        profileId: "synthetic:default",
        promptContains: "Enter Synthetic API key",
        provider: "synthetic",
        token: "sk-synthetic-test",
      },
      {
        authChoice: "huggingface-api-key" as const,
        profileId: "huggingface:default",
        promptContains: "Hugging Face",
        provider: "huggingface",
        token: "hf-test-token",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();

      const text = vi.fn().mockResolvedValue(scenario.token);
      const { prompter, runtime } = createApiKeyPromptHarness({ text });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining(scenario.promptContains) }),
      );
      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        mode: "api_key",
        provider: scenario.provider,
      });
      expect((await readAuthProfile(scenario.profileId))?.key).toBe(scenario.token);
    }
  });

  it("uses Z.AI endpoint detection and prompts in the auth flow", async () => {
    const scenarios: {
      authChoice: "zai-api-key" | "zai-coding-global";
      token: string;
      endpointSelection?: "coding-cn" | "global";
      detectResult?: {
        endpoint: "coding-global" | "coding-cn";
        modelId: string;
        baseUrl: string;
        note: string;
      };
      shouldPromptForEndpoint: boolean;
      expectedDetectCall?: { apiKey: string; endpoint?: "coding-global" | "coding-cn" };
    }[] = [
      {
        authChoice: "zai-api-key",
        endpointSelection: "coding-cn",
        shouldPromptForEndpoint: true,
        token: "zai-test-key",
      },
      {
        authChoice: "zai-coding-global",
        detectResult: {
          baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
          endpoint: "coding-global",
          modelId: "glm-4.7",
          note: "Detected coding-global endpoint with GLM-4.7 fallback",
        },
        expectedDetectCall: { apiKey: "zai-test-key", endpoint: "coding-global" },
        shouldPromptForEndpoint: false,
        token: "zai-test-key",
      },
      {
        authChoice: "zai-api-key",
        detectResult: {
          baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
          endpoint: "coding-global",
          modelId: "glm-4.5",
          note: "Detected coding-global endpoint",
        },
        expectedDetectCall: { apiKey: "zai-detected-key" },
        shouldPromptForEndpoint: false,
        token: "zai-detected-key",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      detectZaiEndpoint.mockReset();
      detectZaiEndpoint.mockResolvedValue(null);
      if (scenario.detectResult) {
        detectZaiEndpoint.mockResolvedValueOnce(scenario.detectResult);
      }

      const text = vi.fn().mockResolvedValue(scenario.token);
      const select = vi.fn(async (params: { message: string }) => {
        if (params.message === "Select Z.AI endpoint") {
          return scenario.endpointSelection ?? "global";
        }
        return "default";
      });
      const { prompter, runtime } = createApiKeyPromptHarness({
        select: select as WizardPrompter["select"],
        text,
      });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      if (scenario.expectedDetectCall) {
        expect(detectZaiEndpoint).toHaveBeenCalledWith(scenario.expectedDetectCall);
      }
      if (scenario.shouldPromptForEndpoint) {
        expect(select).toHaveBeenCalledWith(
          expect.objectContaining({ initialValue: "global", message: "Select Z.AI endpoint" }),
        );
      } else {
        expect(select).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: "Select Z.AI endpoint" }),
        );
      }
      expect(result.config.auth?.profiles?.["zai:default"]).toMatchObject({
        mode: "api_key",
        provider: "zai",
      });
      expect((await readAuthProfile("zai:default"))?.key).toBe(scenario.token);
    }
  });

  it("maps apiKey tokenProvider aliases to provider flow", async () => {
    const scenarios: {
      tokenProvider: string;
      token: string;
      profileId: string;
      provider: string;
      expectedModel?: string;
      expectedModelPrefix?: string;
    }[] = [
      {
        expectedModelPrefix: "huggingface/",
        profileId: "huggingface:default",
        provider: "huggingface",
        token: "hf-token-provider-test",
        tokenProvider: "huggingface",
      },
      {
        expectedModelPrefix: "together/",
        profileId: "together:default",
        provider: "together",
        token: "sk-together-token-provider-test",
        tokenProvider: "  ToGeThEr  ",
      },
      {
        expectedModelPrefix: "kimi/",
        profileId: "kimi:default",
        provider: "kimi",
        token: "sk-kimi-token-provider-test",
        tokenProvider: "KIMI-CODING",
      },
      {
        expectedModel: GOOGLE_GEMINI_DEFAULT_MODEL,
        profileId: "google:default",
        provider: "google",
        token: "sk-gemini-token-provider-test",
        tokenProvider: " GOOGLE  ",
      },
      {
        expectedModelPrefix: "litellm/",
        profileId: "litellm:default",
        provider: "litellm",
        token: "sk-litellm-token-provider-test",
        tokenProvider: " LITELLM  ",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env.HF_TOKEN;
      delete process.env.HUGGINGFACE_HUB_TOKEN;

      const text = vi.fn().mockResolvedValue("should-not-be-used");
      const confirm = vi.fn(async () => false);
      const { prompter, runtime } = createApiKeyPromptHarness({ confirm, text });

      const result = await applyAuthChoice({
        authChoice: "apiKey",
        config: {},
        opts: {
          token: scenario.token,
          tokenProvider: scenario.tokenProvider,
        },
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        mode: "api_key",
        provider: scenario.provider,
      });
      if (scenario.expectedModel) {
        expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
          scenario.expectedModel,
        );
      }
      if (scenario.expectedModelPrefix) {
        expect(
          resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)?.startsWith(
            scenario.expectedModelPrefix,
          ),
        ).toBe(true);
      }
      expect(text).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect((await readAuthProfile(scenario.profileId))?.key).toBe(scenario.token);
    }
  });

  it.each([
    {
      authChoice: "moonshot-api-key",
      modelPrefix: "moonshot/",
      profileId: "moonshot:default",
      provider: "moonshot",
      tokenProvider: "moonshot",
    },
    {
      authChoice: "mistral-api-key",
      modelPrefix: "mistral/",
      profileId: "mistral:default",
      provider: "mistral",
      tokenProvider: "mistral",
    },
    {
      authChoice: "kimi-code-api-key",
      modelPrefix: "kimi/",
      profileId: "kimi:default",
      provider: "kimi",
      tokenProvider: "kimi-code",
    },
    {
      authChoice: "xiaomi-api-key",
      modelPrefix: "xiaomi/",
      profileId: "xiaomi:default",
      provider: "xiaomi",
      tokenProvider: "xiaomi",
    },
    {
      authChoice: "venice-api-key",
      modelPrefix: "venice/",
      profileId: "venice:default",
      provider: "venice",
      tokenProvider: "venice",
    },
    {
      authChoice: "opencode-zen",
      extraProfiles: ["opencode-go:default"],
      modelPrefix: "opencode/",
      profileId: "opencode:default",
      provider: "opencode",
      tokenProvider: "opencode",
    },
    {
      authChoice: "opencode-go",
      extraProfiles: ["opencode:default"],
      modelPrefix: "opencode-go/",
      profileId: "opencode-go:default",
      provider: "opencode-go",
      tokenProvider: "opencode-go",
    },
    {
      authChoice: "together-api-key",
      modelPrefix: "together/",
      profileId: "together:default",
      provider: "together",
      tokenProvider: "together",
    },
    {
      authChoice: "qianfan-api-key",
      modelPrefix: "qianfan/",
      profileId: "qianfan:default",
      provider: "qianfan",
      tokenProvider: "qianfan",
    },
    {
      authChoice: "synthetic-api-key",
      modelPrefix: "synthetic/",
      profileId: "synthetic:default",
      provider: "synthetic",
      tokenProvider: "synthetic",
    },
  ] as const)(
    "uses opts token for $authChoice without prompting",
    async ({ authChoice, tokenProvider, profileId, provider, modelPrefix, extraProfiles }) => {
      await setupTempState();

      const text = vi.fn();
      const confirm = vi.fn(async () => false);
      const { prompter, runtime } = createApiKeyPromptHarness({ confirm, text });
      const token = `sk-${tokenProvider}-test`;

      const result = await applyAuthChoice({
        authChoice,
        config: {},
        opts: {
          token,
          tokenProvider,
        },
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(text).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(result.config.auth?.profiles?.[profileId]).toMatchObject({
        mode: "api_key",
        provider,
      });
      expect(
        resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)?.startsWith(
          modelPrefix,
        ),
      ).toBe(true);
      expect((await readAuthProfile(profileId))?.key).toBe(token);
      for (const extraProfile of extraProfiles ?? []) {
        expect((await readAuthProfile(extraProfile))?.key).toBe(token);
      }
    },
  );

  it("uses opts token for Gemini and keeps global default model when setDefaultModel=false", async () => {
    await setupTempState();

    const text = vi.fn();
    const confirm = vi.fn(async () => false);
    const { prompter, runtime } = createApiKeyPromptHarness({ confirm, text });

    const result = await applyAuthChoice({
      authChoice: "gemini-api-key",
      config: { agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } } },
      opts: {
        token: "sk-gemini-test",
        tokenProvider: "google",
      },
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["google:default"]).toMatchObject({
      mode: "api_key",
      provider: "google",
    });
    expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
      "openai/gpt-4o-mini",
    );
    expect(result.agentModelOverride).toBe(GOOGLE_GEMINI_DEFAULT_MODEL);
    expect((await readAuthProfile("google:default"))?.key).toBe("sk-gemini-test");
  });

  it("prompts for Venice API key and shows the Venice note when no token is provided", async () => {
    await setupTempState();
    process.env.VENICE_API_KEY = "";

    const note = vi.fn(async () => {});
    const text = vi.fn(async () => "sk-venice-manual");
    const prompter = createPrompter({ note, text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "venice-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("privacy-focused inference"),
      "Venice AI",
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enter Venice AI API key",
      }),
    );
    expect(result.config.auth?.profiles?.["venice:default"]).toMatchObject({
      mode: "api_key",
      provider: "venice",
    });
    expect((await readAuthProfile("venice:default"))?.key).toBe("sk-venice-manual");
  });

  it("uses existing env API keys for selected providers", async () => {
    const scenarios: {
      authChoice: "synthetic-api-key" | "openrouter-api-key" | "ai-gateway-api-key";
      envKey: "SYNTHETIC_API_KEY" | "OPENROUTER_API_KEY" | "AI_GATEWAY_API_KEY";
      envValue: string;
      profileId: string;
      provider: string;
      opts?: { secretInputMode?: "ref" };
      expectEnvPrompt: boolean;
      expectedTextCalls: number;
      expectedKey?: string;
      expectedKeyRef?: { source: "env"; provider: string; id: string };
      expectedModel?: string;
      expectedModelPrefix?: string;
    }[] = [
      {
        authChoice: "synthetic-api-key",
        envKey: "SYNTHETIC_API_KEY",
        envValue: "sk-synthetic-env",
        expectEnvPrompt: true,
        expectedKey: "sk-synthetic-env",
        expectedModelPrefix: "synthetic/",
        expectedTextCalls: 0,
        profileId: "synthetic:default",
        provider: "synthetic",
      },
      {
        authChoice: "openrouter-api-key",
        envKey: "OPENROUTER_API_KEY",
        envValue: "sk-openrouter-test",
        expectEnvPrompt: true,
        expectedKey: "sk-openrouter-test",
        expectedModel: "openrouter/auto",
        expectedTextCalls: 0,
        profileId: "openrouter:default",
        provider: "openrouter",
      },
      {
        authChoice: "ai-gateway-api-key",
        envKey: "AI_GATEWAY_API_KEY",
        envValue: "gateway-test-key",
        expectEnvPrompt: true,
        expectedKey: "gateway-test-key",
        expectedModel: "vercel-ai-gateway/anthropic/claude-opus-4.6",
        expectedTextCalls: 0,
        profileId: "vercel-ai-gateway:default",
        provider: "vercel-ai-gateway",
      },
      {
        authChoice: "ai-gateway-api-key",
        envKey: "AI_GATEWAY_API_KEY",
        envValue: "gateway-ref-key",
        profileId: "vercel-ai-gateway:default",
        provider: "vercel-ai-gateway",
        opts: { secretInputMode: "ref" }, // Pragma: allowlist secret
        expectEnvPrompt: false,
        expectedTextCalls: 1,
        expectedKeyRef: { id: "AI_GATEWAY_API_KEY", provider: "default", source: "env" },
        expectedModel: "vercel-ai-gateway/anthropic/claude-opus-4.6",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env.SYNTHETIC_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.AI_GATEWAY_API_KEY;
      process.env[scenario.envKey] = scenario.envValue;

      const text = vi.fn();
      const confirm = vi.fn(async () => true);
      const { prompter, runtime } = createApiKeyPromptHarness({ confirm, text });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        opts: scenario.opts,
        prompter,
        runtime,
        setDefaultModel: true,
      });

      if (scenario.expectEnvPrompt) {
        expect(confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining(scenario.envKey),
          }),
        );
      } else {
        expect(confirm).not.toHaveBeenCalled();
      }
      expect(text).toHaveBeenCalledTimes(scenario.expectedTextCalls);
      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        mode: "api_key",
        provider: scenario.provider,
      });
      if (scenario.expectedModel) {
        expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
          scenario.expectedModel,
        );
      }
      if (scenario.expectedModelPrefix) {
        expect(
          resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)?.startsWith(
            scenario.expectedModelPrefix,
          ),
        ).toBe(true);
      }
      const profile = await readAuthProfile(scenario.profileId);
      if (scenario.expectedKeyRef) {
        expect(profile?.keyRef).toEqual(scenario.expectedKeyRef);
        expect(profile?.key).toBeUndefined();
      } else {
        expect(profile?.key).toBe(scenario.expectedKey);
        expect(profile?.keyRef).toBeUndefined();
      }
    }
  });

  it("retries ref setup when provider preflight fails and can switch to env ref", async () => {
    await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-env"; // Pragma: allowlist secret

    const selectValues: ("provider" | "env" | "filemain")[] = ["provider", "filemain", "env"];
    const select = vi.fn(async (params: Parameters<WizardPrompter["select"]>[0]) => {
      const next = selectValues[0];
      if (next && params.options.some((option) => option.value === next)) {
        selectValues.shift();
        return next as never;
      }
      return (params.options[0]?.value ?? "env") as never;
    });
    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("/providers/openai/apiKey")
      .mockResolvedValueOnce("OPENAI_API_KEY");
    const note = vi.fn(async () => undefined);

    const prompter = createPrompter({
      confirm: vi.fn(async () => true),
      note,
      select,
      text,
    });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "openai-api-key",
      config: {
        secrets: {
          providers: {
            filemain: {
              mode: "json",
              path: "/tmp/openclaw-missing-secrets.json",
              source: "file",
            },
          },
        },
      },
      opts: { secretInputMode: "ref" },
      prompter,
      runtime,
      setDefaultModel: false, // Pragma: allowlist secret
    });

    expect(result.config.auth?.profiles?.["openai:default"]).toMatchObject({
      mode: "api_key",
      provider: "openai",
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Could not validate provider reference"),
      "Reference check failed",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Validated environment variable OPENAI_API_KEY."),
      "Reference validated",
    );
    expect(await readAuthProfile("openai:default")).toMatchObject({
      keyRef: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
    });
  });

  it("uses explicit env for plugin auth resolution instead of host env", async () => {
    await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-host"; // Pragma: allowlist secret
    const env = { OPENAI_API_KEY: "sk-openai-explicit" } as NodeJS.ProcessEnv; // Pragma: allowlist secret
    const text = vi.fn().mockResolvedValue("should-not-be-used");
    const confirm = vi.fn(async () => true);
    const { prompter, runtime } = createApiKeyPromptHarness({ confirm, text });

    const result = await applyAuthChoice({
      authChoice: "openai-api-key",
      config: {},
      env,
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        env,
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("OPENAI_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["openai:default"]).toMatchObject({
      mode: "api_key",
      provider: "openai",
    });
    expect((await readAuthProfile("openai:default"))?.key).toBe("sk-openai-explicit");
  });

  it("keeps existing default model for explicit provider keys when setDefaultModel=false", async () => {
    const scenarios: {
      authChoice: "synthetic-api-key" | "opencode-zen" | "opencode-go";
      token: string;
      promptMessage: string;
      existingPrimary: string;
      expectedOverride: string;
      profileId?: string;
      profileProvider?: string;
      extraProfileId?: string;
      expectProviderConfigUndefined?: "opencode" | "opencode-go" | "opencode-zen";
      agentId?: string;
    }[] = [
      {
        agentId: "agent-1",
        authChoice: "synthetic-api-key",
        existingPrimary: "openai/gpt-4o-mini",
        expectedOverride: "synthetic/Synthetic-1",
        profileId: "synthetic:default",
        profileProvider: "synthetic",
        promptMessage: "Enter Synthetic API key",
        token: "sk-synthetic-agent-test",
      },
      {
        authChoice: "opencode-zen",
        existingPrimary: "anthropic/claude-opus-4-5",
        expectProviderConfigUndefined: "opencode",
        expectedOverride: "opencode/claude-opus-4-6",
        extraProfileId: "opencode-go:default",
        profileId: "opencode:default",
        profileProvider: "opencode",
        promptMessage: "Enter OpenCode API key",
        token: "sk-opencode-zen-test",
      },
      {
        authChoice: "opencode-go",
        existingPrimary: "anthropic/claude-opus-4-5",
        expectProviderConfigUndefined: "opencode-go",
        expectedOverride: "opencode-go/kimi-k2.5",
        extraProfileId: "opencode:default",
        profileId: "opencode-go:default",
        profileProvider: "opencode-go",
        promptMessage: "Enter OpenCode API key",
        token: "sk-opencode-go-test",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();

      const text = vi.fn().mockResolvedValue(scenario.token);
      const { prompter, runtime } = createApiKeyPromptHarness({ text });

      const result = await applyAuthChoice({
        agentId: scenario.agentId,
        authChoice: scenario.authChoice,
        config: { agents: { defaults: { model: { primary: scenario.existingPrimary } } } },
        prompter,
        runtime,
        setDefaultModel: false,
      });

      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({ message: scenario.promptMessage }),
      );
      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        scenario.existingPrimary,
      );
      expect(result.agentModelOverride).toBe(scenario.expectedOverride);
      if (scenario.profileId && scenario.profileProvider) {
        expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
          mode: "api_key",
          provider: scenario.profileProvider,
        });
        const profileStore =
          scenario.agentId && scenario.agentId !== "default"
            ? await readAuthProfilesForAgent<{ profiles?: Record<string, StoredAuthProfile> }>(
                resolveAgentDir(result.config, scenario.agentId),
              )
            : await readAuthProfiles();
        expect(profileStore.profiles?.[scenario.profileId]?.key).toBe(scenario.token);
      }
      if (scenario.extraProfileId) {
        const profileStore =
          scenario.agentId && scenario.agentId !== "default"
            ? await readAuthProfilesForAgent<{ profiles?: Record<string, StoredAuthProfile> }>(
                resolveAgentDir(result.config, scenario.agentId),
              )
            : await readAuthProfiles();
        expect(profileStore.profiles?.[scenario.extraProfileId]?.key).toBe(scenario.token);
      }
      if (scenario.expectProviderConfigUndefined) {
        expect(
          result.config.models?.providers?.[scenario.expectProviderConfigUndefined],
        ).toBeUndefined();
      }
    }
  });

  it("sets default model when selecting github-copilot", async () => {
    await setupTempState();

    resolvePluginProviders.mockReturnValue([
      {
        auth: [
          {
            id: "device",
            kind: "device_code",
            label: "GitHub device login",
            run: vi.fn(async () => ({
              profiles: [
                {
                  profileId: "github-copilot:github",
                  credential: {
                    type: "token",
                    provider: "github-copilot",
                    token: "github-device-token",
                  },
                },
              ],
              defaultModel: "github-copilot/gpt-4o",
            })),
          },
        ],
        id: "github-copilot",
        label: "GitHub Copilot",
      },
    ] as never);

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const hadOwnIsTTY = Object.hasOwn(stdin, "isTTY");
    const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      get: () => true,
    });

    try {
      const result = await applyAuthChoice({
        authChoice: "github-copilot",
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        "github-copilot/gpt-4o",
      );
    } finally {
      if (previousIsTTYDescriptor) {
        Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
      } else if (!hadOwnIsTTY) {
        delete (stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it("does not persist literal 'undefined' when API key prompts return undefined", async () => {
    const scenarios = [
      {
        authChoice: "synthetic-api-key" as const,
        envKey: "SYNTHETIC_API_KEY",
        profileId: "synthetic:default",
        provider: "synthetic",
      },
    ];

    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env[scenario.envKey];

      const text = vi.fn(async () => undefined as unknown as string);
      const prompter = createPrompter({ text });
      const runtime = createExitThrowingRuntime();

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: false,
      });

      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        mode: "api_key",
        provider: scenario.provider,
      });

      const profile = await readAuthProfile(scenario.profileId);
      expect(profile?.key).toBe("");
      expect(profile?.key).not.toBe("undefined");
    }
  });

  it("ignores legacy LiteLLM oauth profiles when selecting litellm-api-key", async () => {
    await setupTempState();
    process.env.LITELLM_API_KEY = "sk-litellm-test"; // Pragma: allowlist secret

    const authProfilePath = authProfilePathForAgent(requireOpenClawAgentDir());
    await fs.writeFile(
      authProfilePath,
      JSON.stringify(
        {
          profiles: {
            "litellm:legacy": {
              access: "access-token",
              expires: Date.now() + 60_000,
              provider: "litellm",
              refresh: "refresh-token",
              type: "oauth",
            },
          },
          version: 1,
        },
        null,
        2,
      ),
      "utf8",
    );

    const text = vi.fn();
    const confirm = vi.fn(async () => true);
    const { prompter, runtime } = createApiKeyPromptHarness({ confirm, text });

    const result = await applyAuthChoice({
      authChoice: "litellm-api-key",
      config: {
        auth: {
          order: { litellm: ["litellm:legacy"] },
          profiles: {
            "litellm:legacy": { mode: "oauth", provider: "litellm" },
          },
        },
      },
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("LITELLM_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["litellm:default"]).toMatchObject({
      mode: "api_key",
      provider: "litellm",
    });

    expect(await readAuthProfile("litellm:default")).toMatchObject({
      key: "sk-litellm-test",
      type: "api_key",
    });
  });

  it("configures cloudflare ai gateway via env key and explicit opts", async () => {
    const scenarios: {
      envGatewayKey?: string;
      textValues: string[];
      confirmValue: boolean;
      opts?: {
        secretInputMode?: "ref"; // Pragma: allowlist secret
        cloudflareAiGatewayAccountId?: string;
        cloudflareAiGatewayGatewayId?: string;
        cloudflareAiGatewayApiKey?: string;
      };
      expectEnvPrompt: boolean;
      expectedTextCalls: number;
      expectedKey?: string;
      expectedKeyRef?: { source: string; provider: string; id: string };
      expectedMetadata: { accountId: string; gatewayId: string };
    }[] = [
      {
        confirmValue: true,
        envGatewayKey: "cf-gateway-test-key",
        expectEnvPrompt: true,
        expectedKey: "cf-gateway-test-key",
        expectedMetadata: {
          accountId: "cf-account-id",
          gatewayId: "cf-gateway-id",
        },
        expectedTextCalls: 2,
        textValues: ["cf-account-id", "cf-gateway-id"],
      },
      {
        confirmValue: true,
        envGatewayKey: "cf-gateway-ref-key",
        expectEnvPrompt: false,
        expectedKeyRef: { id: "CLOUDFLARE_AI_GATEWAY_API_KEY", provider: "default", source: "env" },
        expectedMetadata: {
          accountId: "cf-account-id-ref",
          gatewayId: "cf-gateway-id-ref",
        },
        expectedTextCalls: 3,
        opts: {
          secretInputMode: "ref", // Pragma: allowlist secret
        },
        textValues: ["cf-account-id-ref", "cf-gateway-id-ref"],
      },
      {
        confirmValue: false,
        expectEnvPrompt: false,
        expectedKey: "cf-direct-key",
        expectedMetadata: {
          accountId: "acc-direct",
          gatewayId: "gw-direct",
        },
        expectedTextCalls: 0,
        opts: {
          cloudflareAiGatewayAccountId: "acc-direct",
          cloudflareAiGatewayApiKey: "cf-direct-key",
          cloudflareAiGatewayGatewayId: "gw-direct", // Pragma: allowlist secret
        },
        textValues: [],
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      if (scenario.envGatewayKey) {
        process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = scenario.envGatewayKey;
      }

      const text = vi.fn();
      for (const textValue of scenario.textValues) {
        text.mockResolvedValueOnce(textValue);
      }
      const confirm = vi.fn(async () => scenario.confirmValue);
      const { prompter, runtime } = createApiKeyPromptHarness({ confirm, text });

      const result = await applyAuthChoice({
        authChoice: "cloudflare-ai-gateway-api-key",
        config: {},
        opts: scenario.opts,
        prompter,
        runtime,
        setDefaultModel: true,
      });

      if (scenario.expectEnvPrompt) {
        expect(confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining("CLOUDFLARE_AI_GATEWAY_API_KEY"),
          }),
        );
      } else {
        expect(confirm).not.toHaveBeenCalled();
      }
      expect(text).toHaveBeenCalledTimes(scenario.expectedTextCalls);
      expect(result.config.auth?.profiles?.["cloudflare-ai-gateway:default"]).toMatchObject({
        mode: "api_key",
        provider: "cloudflare-ai-gateway",
      });
      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        "cloudflare-ai-gateway/claude-sonnet-4-5",
      );

      const profile = await readAuthProfile("cloudflare-ai-gateway:default");
      if (scenario.expectedKeyRef) {
        expect(profile?.keyRef).toEqual(scenario.expectedKeyRef);
      } else {
        expect(profile?.key).toBe(scenario.expectedKey);
      }
      expect(profile?.metadata).toEqual(scenario.expectedMetadata);
    }
    delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  });

  it("writes Chutes OAuth credentials when selecting chutes (remote/manual)", async () => {
    await setupTempState();
    process.env.SSH_TTY = "1";
    process.env.CHUTES_CLIENT_ID = "cid_test";

    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.chutes.ai/idp/token") {
        return new Response(
          JSON.stringify({
            access_token: "at_test",
            expires_in: 3600,
            refresh_token: "rt_test",
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        );
      }
      if (url === "https://api.chutes.ai/idp/userinfo") {
        return new Response(JSON.stringify({ username: "remote-user" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const runtime = createExitThrowingRuntime();
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message.startsWith("Paste the redirect URL")) {
        const runtimeLog = runtime.log as ReturnType<typeof vi.fn>;
        const lastLog = runtimeLog.mock.calls.at(-1)?.[0];
        const urlLine = typeof lastLog === "string" ? lastLog : String(lastLog ?? "");
        const urlMatch = urlLine.match(/https?:\/\/\S+/)?.[0] ?? "";
        const state = urlMatch ? new URL(urlMatch).searchParams.get("state") : null;
        if (!state) {
          throw new Error("missing state in oauth URL");
        }
        return `?code=code_manual&state=${state}`;
      }
      return "code_manual";
    });
    const { prompter } = createApiKeyPromptHarness({ text });

    const result = await applyAuthChoice({
      authChoice: "chutes",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Paste the redirect URL"),
      }),
    );
    expect(result.config.auth?.profiles?.["chutes:remote-user"]).toMatchObject({
      mode: "oauth",
      provider: "chutes",
    });

    expect(await readAuthProfile("chutes:remote-user")).toMatchObject({
      access: "at_test",
      email: "remote-user",
      provider: "chutes",
      refresh: "rt_test",
    });
  });

  it("writes portal OAuth credentials for plugin providers", async () => {
    const scenarios: {
      authChoice: "minimax-global-oauth";
      label: string;
      authId: string;
      authLabel: string;
      providerId: string;
      profileId: string;
      baseUrl: string;
      api: "openai-completions" | "anthropic-messages";
      defaultModel: string;
      apiKey: string;
      selectValue?: string;
    }[] = [
      {
        api: "anthropic-messages",
        apiKey: "minimax-oauth",
        authChoice: "minimax-global-oauth",
        authId: "oauth",
        authLabel: "MiniMax OAuth (Global)",
        baseUrl: "https://api.minimax.io/anthropic",
        defaultModel: "minimax-portal/MiniMax-M2.7",
        label: "MiniMax",
        profileId: "minimax-portal:default",
        providerId: "minimax-portal", // Pragma: allowlist secret
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();

      resolvePluginProviders.mockReturnValue([
        {
          auth: [
            {
              id: scenario.authId,
              kind: "device_code",
              label: scenario.authLabel,
              run: vi.fn(async () => ({
                profiles: [
                  {
                    profileId: scenario.profileId,
                    credential: {
                      type: "oauth",
                      provider: scenario.providerId,
                      access: "access",
                      refresh: "refresh",
                      expires: Date.now() + 60 * 60 * 1000,
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      [scenario.providerId]: {
                        baseUrl: scenario.baseUrl,
                        apiKey: scenario.apiKey,
                        api: scenario.api,
                        models: [],
                      },
                    },
                  },
                },
                defaultModel: scenario.defaultModel,
              })),
              wizard: { choiceId: scenario.authChoice },
            },
          ],
          id: scenario.providerId,
          label: scenario.label,
        },
      ] as never);

      const prompter = createPrompter(
        scenario.selectValue
          ? { select: vi.fn(async () => scenario.selectValue as never) as WizardPrompter["select"] }
          : {},
      );
      const runtime = createExitThrowingRuntime();

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        mode: "oauth",
        provider: scenario.providerId,
      });
      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        scenario.defaultModel,
      );
      expect(result.config.models?.providers?.[scenario.providerId]).toMatchObject({
        apiKey: scenario.apiKey,
        baseUrl: scenario.baseUrl,
      });
      expect(await readAuthProfile(scenario.profileId)).toMatchObject({
        access: "access",
        provider: scenario.providerId,
        refresh: "refresh",
      });
    }
  });
});

describe("resolvePreferredProviderForAuthChoice", () => {
  it("maps known and unknown auth choices", async () => {
    const scenarios = [
      { authChoice: "github-copilot" as const, expectedProvider: "github-copilot" },
      { authChoice: "mistral-api-key" as const, expectedProvider: "mistral" },
      { authChoice: "ollama" as const, expectedProvider: "ollama" },
      { authChoice: "unknown" as AuthChoice, expectedProvider: undefined },
    ] as const;
    for (const scenario of scenarios) {
      await expect(
        resolvePreferredProviderForAuthChoice({ choice: scenario.authChoice }),
      ).resolves.toBe(scenario.expectedProvider);
    }
  });
});
