import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import plugin from "./index.js";
import {
  OPENAI_FRIENDLY_PROMPT_OVERLAY,
  OPENAI_GPT5_EXECUTION_BIAS,
  OPENAI_GPT5_OUTPUT_CONTRACT,
} from "./prompt-overlay.js";

const runtimeMocks = vi.hoisted(() => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher,
}));

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    refreshOpenAICodexToken: runtimeMocks.refreshOpenAICodexToken,
  };
});

import { refreshOpenAICodexToken } from "./openai-codex-provider.runtime.js";

const _registerOpenAIPlugin = async () =>
  registerProviderPlugin({
    id: "openai",
    name: "OpenAI Provider",
    plugin,
  });

async function registerOpenAIPluginWithHook(params?: { pluginConfig?: Record<string, unknown> }) {
  const on = vi.fn();
  const providers: ProviderPlugin[] = [];
  await plugin.register(
    createTestPluginApi({
      config: {},
      id: "openai",
      name: "OpenAI Provider",
      on,
      pluginConfig: params?.pluginConfig,
      registerProvider: (provider) => {
        providers.push(provider);
      },
      runtime: {} as never,
      source: "test",
    }),
  );
  return { on, providers };
}

describe("openai plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates PNG buffers from the OpenAI Images API", async () => {
    const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [
          {
            b64_json: Buffer.from("png-data").toString("base64"),
            revised_prompt: "revised",
          },
        ],
      }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { profiles: {}, version: 1 };
    const result = await provider.generateImage({
      authStore,
      cfg: {},
      model: "gpt-image-1",
      prompt: "draw a cat",
      provider: "openai",
    });

    expect(resolveApiKeySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        store: authStore,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        body: JSON.stringify({
          model: "gpt-image-1",
          n: 1,
          prompt: "draw a cat",
          size: "1024x1024",
        }),
        method: "POST",
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          fileName: "image-1.png",
          mimeType: "image/png",
          revisedPrompt: "revised",
        },
      ],
      model: "gpt-image-1",
    });
  });

  it("submits reference-image edits to the OpenAI Images edits endpoint", async () => {
    const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [
          {
            b64_json: Buffer.from("edited-image").toString("base64"),
          },
        ],
      }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { profiles: {}, version: 1 };

    const result = await provider.generateImage({
      authStore,
      cfg: {},
      inputImages: [
        { buffer: Buffer.from("x"), mimeType: "image/png" },
        { buffer: Buffer.from("y"), fileName: "ref.jpg", mimeType: "image/jpeg" },
      ],
      model: "gpt-image-1",
      prompt: "Edit this image",
      provider: "openai",
    });

    expect(resolveApiKeySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        store: authStore,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/edits",
      expect.objectContaining({
        body: JSON.stringify({
          images: [
            {
              image_url: "data:image/png;base64,eA==",
            },
            {
              image_url: "data:image/jpeg;base64,eQ==",
            },
          ],
          model: "gpt-image-1",
          n: 1,
          prompt: "Edit this image",
          size: "1024x1024",
        }),
        method: "POST",
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("edited-image"),
          fileName: "image-1.png",
          mimeType: "image/png",
        },
      ],
      model: "gpt-image-1",
    });
  });

  it("does not allow private-network routing just because a custom base URL is configured", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    await expect(
      provider.generateImage({
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [],
              },
            },
          },
        } satisfies OpenClawConfig,
        model: "gpt-image-1",
        prompt: "draw a cat",
        provider: "openai",
      }),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bootstraps the env proxy dispatcher before refreshing codex oauth credentials", async () => {
    const refreshed = {
      access: "next-access",
      expires: Date.now() + 60_000,
      refresh: "next-refresh",
    };
    runtimeMocks.refreshOpenAICodexToken.mockResolvedValue(refreshed);

    await expect(refreshOpenAICodexToken("refresh-token")).resolves.toBe(refreshed);

    expect(runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher).toHaveBeenCalledOnce();
    expect(runtimeMocks.refreshOpenAICodexToken).toHaveBeenCalledOnce();
    expect(
      runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher.mock.invocationCallOrder[0],
    ).toBeLessThan(runtimeMocks.refreshOpenAICodexToken.mock.invocationCallOrder[0]);
  });

  it("registers GPT-5 system prompt contributions when the friendly overlay is enabled", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "friendly" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    const codexProvider = requireRegisteredProvider(providers, "openai-codex");
    const contributionContext: Parameters<
      NonNullable<ProviderPlugin["resolveSystemPromptContribution"]>
    >[0] = {
      agentDir: undefined,
      agentId: undefined,
      config: undefined,
      modelId: "gpt-5.4",
      promptMode: "full",
      provider: "openai",
      runtimeCapabilities: undefined,
      runtimeChannel: undefined,
      workspaceDir: undefined,
    };

    expect(openaiProvider.resolveSystemPromptContribution?.(contributionContext)).toEqual({
      sectionOverrides: {
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
      },
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
    });
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("This is a live chat, not a memo.");
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Avoid walls of text, long preambles, and repetitive restatement.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Have emotional range when it fits the moment.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Occasional emoji are welcome when they fit naturally, especially for warmth or brief celebration; keep them sparse.",
    );
    expect(codexProvider.resolveSystemPromptContribution?.(contributionContext)).toEqual({
      sectionOverrides: {
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
      },
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
    });
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        ...contributionContext,
        modelId: "gpt-image-1",
      }),
    ).toBeUndefined();
  });

  it("includes stronger execution guidance in the OpenAI prompt overlay", () => {
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "If the user asks you to do the work, start in the same turn instead of restating the plan.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      'If the latest user message is a short approval like "ok do it" or "go ahead", skip the recap and start acting.',
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Commentary-only turns are incomplete when the next action is clear.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      'Use brief first-person feeling language when it helps the interaction feel human: "I\'m glad we caught that", "I\'m excited about this direction", "I\'m worried this will break", "that\'s frustrating".',
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Occasional emoji are welcome when they fit naturally, especially for warmth or brief celebration; keep them sparse.",
    );
    expect(OPENAI_GPT5_EXECUTION_BIAS).toContain(
      "Do prerequisite lookup or discovery before dependent actions.",
    );
    expect(OPENAI_GPT5_OUTPUT_CONTRACT).toContain(
      "Return the requested sections only, in the requested order.",
    );
    expect(OPENAI_GPT5_OUTPUT_CONTRACT).toContain(
      "Prefer commas, periods, or parentheses over em dashes in normal prose.",
    );
    expect(OPENAI_GPT5_OUTPUT_CONTRACT).toContain(
      "Do not use em dashes unless the user explicitly asks for them or they are required in quoted text.",
    );
  });

  it("defaults to the friendly OpenAI interaction-style overlay", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook();

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        agentDir: undefined,
        agentId: undefined,
        config: undefined,
        modelId: "gpt-5.4",
        promptMode: "full",
        provider: "openai",
        runtimeCapabilities: undefined,
        runtimeChannel: undefined,
        workspaceDir: undefined,
      }),
    ).toEqual({
      sectionOverrides: {
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
      },
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
    });
  });

  it("supports opting out of the friendly prompt overlay via plugin config", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "off" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        agentDir: undefined,
        agentId: undefined,
        config: undefined,
        modelId: "gpt-5.4",
        promptMode: "full",
        provider: "openai",
        runtimeCapabilities: undefined,
        runtimeChannel: undefined,
        workspaceDir: undefined,
      }),
    ).toEqual({
      sectionOverrides: {
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
    });
  });

  it("treats mixed-case off values as disabling the friendly prompt overlay", async () => {
    const { providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "Off" },
    });

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        agentDir: undefined,
        agentId: undefined,
        config: undefined,
        modelId: "gpt-5.4",
        promptMode: "full",
        provider: "openai",
        runtimeCapabilities: undefined,
        runtimeChannel: undefined,
        workspaceDir: undefined,
      }),
    ).toEqual({
      sectionOverrides: {
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
    });
  });

  it("supports explicitly configuring the friendly prompt overlay", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "friendly" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        agentDir: undefined,
        agentId: undefined,
        config: undefined,
        modelId: "gpt-5.4",
        promptMode: "full",
        provider: "openai",
        runtimeCapabilities: undefined,
        runtimeChannel: undefined,
        workspaceDir: undefined,
      }),
    ).toEqual({
      sectionOverrides: {
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
      },
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
    });
  });

  it("treats on as an alias for the friendly prompt overlay", async () => {
    const { providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "on" },
    });

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        agentDir: undefined,
        agentId: undefined,
        config: undefined,
        modelId: "gpt-5.4",
        promptMode: "full",
        provider: "openai",
        runtimeCapabilities: undefined,
        runtimeChannel: undefined,
        workspaceDir: undefined,
      }),
    ).toEqual({
      sectionOverrides: {
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
      },
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
    });
  });
});
