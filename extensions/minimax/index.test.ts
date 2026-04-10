import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import { registerMinimaxProviders } from "./provider-registration.js";
import { createMiniMaxWebSearchProvider } from "./src/minimax-web-search-provider.js";

const minimaxProviderPlugin = {
  register(api: Parameters<typeof registerMinimaxProviders>[0]) {
    registerMinimaxProviders(api);
    api.registerWebSearchProvider(createMiniMaxWebSearchProvider());
  },
};

describe("minimax provider hooks", () => {
  it("keeps native reasoning mode for MiniMax transports", async () => {
    const { providers } = await registerProviderPlugin({
      id: "minimax",
      name: "MiniMax Provider",
      plugin: minimaxProviderPlugin,
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    expect(apiProvider.hookAliases).toContain("minimax-cn");
    expect(
      apiProvider.resolveReasoningOutputMode?.({
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
        provider: "minimax",
      } as never),
    ).toBe("native");

    expect(portalProvider.hookAliases).toContain("minimax-portal-cn");
    expect(
      portalProvider.resolveReasoningOutputMode?.({
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
        provider: "minimax-portal",
      } as never),
    ).toBe("native");
  });

  it("owns replay policy for Anthropic and OpenAI-compatible MiniMax transports", async () => {
    const { providers } = await registerProviderPlugin({
      id: "minimax",
      name: "MiniMax Provider",
      plugin: minimaxProviderPlugin,
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    expect(
      apiProvider.buildReplayPolicy?.({
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
        provider: "minimax",
      } as never),
    ).toMatchObject({
      preserveSignatures: true,
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      validateAnthropicTurns: true,
    });

    expect(
      portalProvider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "MiniMax-M2.7",
        provider: "minimax-portal",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: true,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
      validateGeminiTurns: true,
    });
  });

  it("owns fast-mode stream wrapping for MiniMax transports", async () => {
    const { providers } = await registerProviderPlugin({
      id: "minimax",
      name: "MiniMax Provider",
      plugin: minimaxProviderPlugin,
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    let resolvedApiModelId = "";
    const captureApiModel: StreamFn = (model) => {
      resolvedApiModelId = String(model.id ?? "");
      return {} as ReturnType<StreamFn>;
    };
    const wrappedApiStream = apiProvider.wrapStreamFn?.({
      extraParams: { fastMode: true },
      modelId: "MiniMax-M2.7",
      provider: "minimax",
      streamFn: captureApiModel,
    } as never);

    void wrappedApiStream?.(
      {
        api: "anthropic-messages",
        id: "MiniMax-M2.7",
        provider: "minimax",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    let resolvedPortalModelId = "";
    const capturePortalModel: StreamFn = (model) => {
      resolvedPortalModelId = String(model.id ?? "");
      return {} as ReturnType<StreamFn>;
    };
    const wrappedPortalStream = portalProvider.wrapStreamFn?.({
      extraParams: { fastMode: true },
      modelId: "MiniMax-M2.7",
      provider: "minimax-portal",
      streamFn: capturePortalModel,
    } as never);

    void wrappedPortalStream?.(
      {
        api: "anthropic-messages",
        id: "MiniMax-M2.7",
        provider: "minimax-portal",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(resolvedApiModelId).toBe("MiniMax-M2.7-highspeed");
    expect(resolvedPortalModelId).toBe("MiniMax-M2.7-highspeed");
  });

  it("registers the bundled MiniMax web search provider", () => {
    const webSearchProviders: unknown[] = [];

    minimaxProviderPlugin.register({
      registerImageGenerationProvider() {},
      registerMediaUnderstandingProvider() {},
      registerMusicGenerationProvider() {},
      registerProvider() {},
      registerSpeechProvider() {},
      registerVideoGenerationProvider() {},
      registerWebSearchProvider(provider: unknown) {
        webSearchProviders.push(provider);
      },
    } as never);

    expect(webSearchProviders).toHaveLength(1);
    expect(webSearchProviders[0]).toMatchObject({
      envVars: ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY"],
      id: "minimax",
      label: "MiniMax Search",
    });
  });

  it("prefers minimax-portal oauth when resolving MiniMax usage auth", async () => {
    const { providers } = await registerProviderPlugin({
      id: "minimax",
      name: "MiniMax Provider",
      plugin: minimaxProviderPlugin,
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const resolveOAuthToken = vi.fn(async (params?: { provider?: string }) =>
      params?.provider === "minimax-portal" ? { token: "portal-oauth-token" } : null,
    );
    const resolveApiKeyFromConfigAndStore = vi.fn(() => undefined);

    await expect(
      apiProvider.resolveUsageAuth?.({
        config: {},
        env: {},
        provider: "minimax",
        resolveApiKeyFromConfigAndStore,
        resolveOAuthToken,
      } as never),
    ).resolves.toEqual({ token: "portal-oauth-token" });

    expect(resolveOAuthToken).toHaveBeenCalledWith({ provider: "minimax-portal" });
    expect(resolveApiKeyFromConfigAndStore).not.toHaveBeenCalled();
  });
});
