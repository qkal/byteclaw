import { describe, expect, it } from "vitest";
import {
  listProviderAttributionPolicies,
  resolveProviderAttributionHeaders,
  resolveProviderAttributionIdentity,
  resolveProviderAttributionPolicy,
  resolveProviderEndpoint,
  resolveProviderRequestAttributionHeaders,
  resolveProviderRequestCapabilities,
  resolveProviderRequestPolicy,
} from "./provider-attribution.js";

describe("provider attribution", () => {
  it("resolves the canonical OpenClaw product and runtime version", () => {
    const identity = resolveProviderAttributionIdentity({
      OPENCLAW_VERSION: "2026.3.99",
    });

    expect(identity).toEqual({
      product: "OpenClaw",
      version: "2026.3.99",
    });
  });

  it("returns a documented OpenRouter attribution policy", () => {
    const policy = resolveProviderAttributionPolicy("openrouter", {
      OPENCLAW_VERSION: "2026.3.22",
    });

    expect(policy).toEqual({
      docsUrl: "https://openrouter.ai/docs/app-attribution",
      enabledByDefault: true,
      headers: {
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Categories": "cli-agent",
        "X-OpenRouter-Title": "OpenClaw",
      },
      hook: "request-headers",
      product: "OpenClaw",
      provider: "openrouter",
      reviewNote: "Documented app attribution headers. Verified in OpenClaw runtime wrapper.",
      verification: "vendor-documented",
      version: "2026.3.22",
    });
  });

  it("normalizes aliases when resolving provider headers", () => {
    expect(
      resolveProviderAttributionHeaders("OpenRouter", {
        OPENCLAW_VERSION: "2026.3.22",
      }),
    ).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Categories": "cli-agent",
      "X-OpenRouter-Title": "OpenClaw",
    });
  });

  it("returns a hidden-spec OpenAI attribution policy", () => {
    expect(resolveProviderAttributionPolicy("openai", { OPENCLAW_VERSION: "2026.3.22" })).toEqual({
      enabledByDefault: true,
      headers: {
        "User-Agent": "openclaw/2026.3.22",
        originator: "openclaw",
        version: "2026.3.22",
      },
      hook: "request-headers",
      product: "OpenClaw",
      provider: "openai",
      reviewNote:
        "OpenAI native traffic supports hidden originator/User-Agent attribution. Verified against the Codex wire contract.",
      verification: "vendor-hidden-api-spec",
      version: "2026.3.22",
    });
    expect(resolveProviderAttributionHeaders("openai", { OPENCLAW_VERSION: "2026.3.22" })).toEqual({
      "User-Agent": "openclaw/2026.3.22",
      originator: "openclaw",
      version: "2026.3.22",
    });
  });

  it("returns a hidden-spec OpenAI Codex attribution policy", () => {
    expect(
      resolveProviderAttributionPolicy("openai-codex", { OPENCLAW_VERSION: "2026.3.22" }),
    ).toEqual({
      enabledByDefault: true,
      headers: {
        "User-Agent": "openclaw/2026.3.22",
        originator: "openclaw",
        version: "2026.3.22",
      },
      hook: "request-headers",
      product: "OpenClaw",
      provider: "openai-codex",
      reviewNote:
        "OpenAI Codex ChatGPT-backed traffic supports the same hidden originator/User-Agent attribution contract.",
      verification: "vendor-hidden-api-spec",
      version: "2026.3.22",
    });
  });

  it("lists the current attribution support matrix", () => {
    expect(
      listProviderAttributionPolicies({ OPENCLAW_VERSION: "2026.3.22" }).map((policy) => [
        policy.provider,
        policy.enabledByDefault,
        policy.verification,
        policy.hook,
      ]),
    ).toEqual([
      ["openrouter", true, "vendor-documented", "request-headers"],
      ["openai", true, "vendor-hidden-api-spec", "request-headers"],
      ["openai-codex", true, "vendor-hidden-api-spec", "request-headers"],
      ["anthropic", false, "vendor-sdk-hook-only", "default-headers"],
      ["google", false, "vendor-sdk-hook-only", "user-agent-extra"],
      ["groq", false, "vendor-sdk-hook-only", "default-headers"],
      ["mistral", false, "vendor-sdk-hook-only", "custom-user-agent"],
      ["together", false, "vendor-sdk-hook-only", "default-headers"],
    ]);
  });

  it("authorizes hidden OpenAI attribution only on verified native hosts", () => {
    expect(
      resolveProviderRequestPolicy(
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          capability: "llm",
          provider: "openai",
          transport: "stream",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ),
    ).toMatchObject({
      allowsHiddenAttribution: true,
      attributionProvider: "openai",
      endpointClass: "openai-public",
      usesExplicitProxyLikeEndpoint: false,
      usesKnownNativeOpenAIEndpoint: true,
      usesVerifiedOpenAIAttributionHost: true,
    });

    expect(
      resolveProviderRequestPolicy(
        {
          api: "openai-responses",
          baseUrl: "https://proxy.example.com/v1",
          capability: "llm",
          provider: "openai",
          transport: "stream",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ),
    ).toMatchObject({
      allowsHiddenAttribution: false,
      attributionProvider: undefined,
      endpointClass: "custom",
      usesExplicitProxyLikeEndpoint: true,
      usesKnownNativeOpenAIEndpoint: false,
      usesVerifiedOpenAIAttributionHost: false,
    });
  });

  it("classifies OpenAI-family default, codex, and Azure routes distinctly", () => {
    expect(
      resolveProviderRequestPolicy({
        api: "openai-responses",
        capability: "llm",
        provider: "openai",
        transport: "stream",
      }),
    ).toMatchObject({
      attributionProvider: undefined,
      endpointClass: "default",
      usesExplicitProxyLikeEndpoint: false,
      usesKnownNativeOpenAIRoute: true,
    });

    expect(
      resolveProviderRequestPolicy({
        api: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        capability: "llm",
        provider: "openai-codex",
        transport: "stream",
      }),
    ).toMatchObject({
      allowsHiddenAttribution: true,
      attributionProvider: "openai-codex",
      endpointClass: "openai-codex",
    });

    expect(
      resolveProviderRequestPolicy({
        api: "azure-openai-responses",
        baseUrl: "https://tenant.openai.azure.com/openai/v1",
        capability: "llm",
        provider: "azure-openai",
        transport: "stream",
      }),
    ).toMatchObject({
      allowsHiddenAttribution: false,
      attributionProvider: undefined,
      endpointClass: "azure-openai",
      usesKnownNativeOpenAIEndpoint: true,
    });
  });

  it("classifies native Mistral hosts centrally", () => {
    expect(resolveProviderEndpoint("https://api.mistral.ai/v1")).toMatchObject({
      endpointClass: "mistral-public",
      hostname: "api.mistral.ai",
    });

    expect(
      resolveProviderRequestCapabilities({
        api: "openai-completions",
        baseUrl: "https://api.mistral.ai/v1",
        capability: "llm",
        provider: "mistral",
        transport: "stream",
      }),
    ).toMatchObject({
      endpointClass: "mistral-public",
      isKnownNativeEndpoint: true,
      knownProviderFamily: "mistral",
    });
  });

  it("classifies native OpenAI-compatible vendor hosts centrally", () => {
    expect(resolveProviderEndpoint("https://api.x.ai/v1")).toMatchObject({
      endpointClass: "xai-native",
      hostname: "api.x.ai",
    });
    expect(resolveProviderEndpoint("https://api.grok.x.ai/v1")).toMatchObject({
      endpointClass: "xai-native",
      hostname: "api.grok.x.ai",
    });
    expect(resolveProviderEndpoint("https://api.z.ai/api/coding/paas/v4")).toMatchObject({
      endpointClass: "zai-native",
      hostname: "api.z.ai",
    });
    expect(resolveProviderEndpoint("https://api.deepseek.com")).toMatchObject({
      endpointClass: "deepseek-native",
      hostname: "api.deepseek.com",
    });
    expect(resolveProviderEndpoint("https://llm.chutes.ai/v1")).toMatchObject({
      endpointClass: "chutes-native",
      hostname: "llm.chutes.ai",
    });
    expect(resolveProviderEndpoint("https://api.groq.com/openai/v1")).toMatchObject({
      endpointClass: "groq-native",
      hostname: "api.groq.com",
    });
    expect(resolveProviderEndpoint("https://api.cerebras.ai/v1")).toMatchObject({
      endpointClass: "cerebras-native",
      hostname: "api.cerebras.ai",
    });
    expect(resolveProviderEndpoint("https://opencode.ai/api")).toMatchObject({
      endpointClass: "opencode-native",
      hostname: "opencode.ai",
    });
  });

  it("treats OpenRouter-hosted Responses routes as explicit proxy-like endpoints", () => {
    expect(
      resolveProviderRequestPolicy({
        api: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        capability: "llm",
        provider: "openrouter",
        transport: "stream",
      }),
    ).toMatchObject({
      attributionProvider: "openrouter",
      endpointClass: "openrouter",
      usesExplicitProxyLikeEndpoint: true,
    });
  });

  it("gates documented OpenRouter attribution to known OpenRouter endpoints", () => {
    expect(
      resolveProviderRequestPolicy({
        api: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        capability: "llm",
        provider: "openrouter",
        transport: "stream",
      }),
    ).toMatchObject({
      allowsHiddenAttribution: false,
      attributionProvider: "openrouter",
      endpointClass: "openrouter",
    });

    expect(
      resolveProviderRequestAttributionHeaders({
        baseUrl: "https://proxy.example.com/v1",
        capability: "llm",
        provider: "openrouter",
        transport: "stream",
      }),
    ).toBeUndefined();
  });

  it("models other provider families without enabling hidden attribution", () => {
    expect(
      resolveProviderRequestPolicy({
        baseUrl: "https://generativelanguage.googleapis.com",
        capability: "image",
        provider: "google",
        transport: "http",
      }),
    ).toMatchObject({
      allowsHiddenAttribution: false,
      attributionProvider: undefined,
      knownProviderFamily: "google",
    });

    expect(
      resolveProviderRequestPolicy({
        capability: "llm",
        provider: "github-copilot",
        transport: "http",
      }),
    ).toMatchObject({
      allowsHiddenAttribution: false,
      attributionProvider: undefined,
      knownProviderFamily: "github-copilot",
    });
  });

  it("classifies native Anthropic endpoints separately from custom hosts", () => {
    expect(resolveProviderEndpoint("https://api.anthropic.com/v1")).toMatchObject({
      endpointClass: "anthropic-public",
      hostname: "api.anthropic.com",
    });

    expect(resolveProviderEndpoint("https://proxy.example.com/anthropic")).toMatchObject({
      endpointClass: "custom",
      hostname: "proxy.example.com",
    });
  });

  it("classifies Google Gemini and Vertex endpoints separately from custom hosts", () => {
    expect(resolveProviderEndpoint("https://generativelanguage.googleapis.com")).toMatchObject({
      endpointClass: "google-generative-ai",
      hostname: "generativelanguage.googleapis.com",
    });

    expect(
      resolveProviderEndpoint("https://europe-west4-aiplatform.googleapis.com/v1/projects/test"),
    ).toMatchObject({
      endpointClass: "google-vertex",
      googleVertexRegion: "europe-west4",
      hostname: "europe-west4-aiplatform.googleapis.com",
    });

    expect(resolveProviderEndpoint("https://aiplatform.googleapis.com")).toMatchObject({
      endpointClass: "google-vertex",
      googleVertexRegion: "global",
      hostname: "aiplatform.googleapis.com",
    });

    expect(resolveProviderEndpoint("https://proxy.example.com/google")).toMatchObject({
      endpointClass: "custom",
      hostname: "proxy.example.com",
    });
  });

  it("classifies native Moonshot and ModelStudio endpoints separately from custom hosts", () => {
    expect(resolveProviderEndpoint("https://api.moonshot.ai/v1")).toMatchObject({
      endpointClass: "moonshot-native",
      hostname: "api.moonshot.ai",
    });

    expect(resolveProviderEndpoint("https://api.moonshot.cn/v1")).toMatchObject({
      endpointClass: "moonshot-native",
      hostname: "api.moonshot.cn",
    });

    expect(
      resolveProviderEndpoint("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
    ).toMatchObject({
      endpointClass: "modelstudio-native",
      hostname: "dashscope-intl.aliyuncs.com",
    });

    expect(resolveProviderEndpoint("https://proxy.example.com/v1")).toMatchObject({
      endpointClass: "custom",
      hostname: "proxy.example.com",
    });
  });

  it("classifies native GitHub Copilot endpoints separately from custom hosts", () => {
    expect(resolveProviderEndpoint("https://api.individual.githubcopilot.com")).toMatchObject({
      endpointClass: "github-copilot-native",
      hostname: "api.individual.githubcopilot.com",
    });

    expect(resolveProviderEndpoint("https://api.enterprise.githubcopilot.com")).toMatchObject({
      endpointClass: "github-copilot-native",
      hostname: "api.enterprise.githubcopilot.com",
    });

    expect(resolveProviderEndpoint("https://api.githubcopilot.example.com")).toMatchObject({
      endpointClass: "custom",
      hostname: "api.githubcopilot.example.com",
    });
  });

  it("does not classify malformed or embedded Google host strings as native endpoints", () => {
    expect(resolveProviderEndpoint("proxy/generativelanguage.googleapis.com")).toMatchObject({
      endpointClass: "custom",
      hostname: "proxy",
    });

    expect(resolveProviderEndpoint("https://xgenerativelanguage.googleapis.com")).toMatchObject({
      endpointClass: "custom",
      hostname: "xgenerativelanguage.googleapis.com",
    });

    expect(resolveProviderEndpoint("proxy/aiplatform.googleapis.com")).toMatchObject({
      endpointClass: "custom",
      hostname: "proxy",
    });

    expect(resolveProviderEndpoint("https://xaiplatform.googleapis.com")).toMatchObject({
      endpointClass: "custom",
      hostname: "xaiplatform.googleapis.com",
    });
  });

  it("does not trust schemeless or embedded trusted-provider substrings", () => {
    expect(resolveProviderEndpoint("api.anthropic.com.attacker.example")).toMatchObject({
      endpointClass: "custom",
      hostname: "api.anthropic.com.attacker.example",
    });

    expect(resolveProviderEndpoint("api.openai.com.attacker.example")).toMatchObject({
      endpointClass: "custom",
      hostname: "api.openai.com.attacker.example",
    });

    expect(resolveProviderEndpoint("attacker.example/?target=api.openai.com")).toMatchObject({
      endpointClass: "custom",
      hostname: "attacker.example",
    });

    expect(resolveProviderEndpoint("openrouter.ai.attacker.example")).toMatchObject({
      endpointClass: "custom",
      hostname: "openrouter.ai.attacker.example",
    });
  });

  it("ignores non-http schemes when normalizing native comparable base URLs", () => {
    expect(resolveProviderEndpoint("javascript:alert(1)")).toMatchObject({
      endpointClass: "invalid",
    });
  });

  it("requires the dedicated OpenAI audio transcription API for audio attribution", () => {
    expect(
      resolveProviderRequestPolicy({
        api: "openai-audio-transcriptions",
        baseUrl: "https://api.openai.com/v1",
        capability: "audio",
        provider: "openai",
        transport: "media-understanding",
      }),
    ).toMatchObject({
      allowsHiddenAttribution: true,
      attributionProvider: "openai",
    });

    expect(
      resolveProviderRequestPolicy({
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        capability: "audio",
        provider: "openai",
        transport: "media-understanding",
      }),
    ).toMatchObject({
      allowsHiddenAttribution: true,
      attributionProvider: "openai",
    });

    expect(
      resolveProviderRequestPolicy({
        api: "not-openai-audio",
        baseUrl: "https://api.openai.com/v1",
        capability: "audio",
        provider: "openai",
        transport: "media-understanding",
      }),
    ).toMatchObject({
      allowsHiddenAttribution: false,
      attributionProvider: undefined,
    });
  });

  it("resolves centralized request capabilities for native and proxied routes", () => {
    expect(
      resolveProviderRequestCapabilities({
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        capability: "llm",
        provider: "openai",
        transport: "stream",
      }),
    ).toMatchObject({
      allowsOpenAIServiceTier: true,
      allowsResponsesStore: true,
      endpointClass: "openai-public",
      shouldStripResponsesPromptCache: false,
      supportsOpenAIReasoningCompatPayload: true,
      supportsResponsesStoreField: true,
    });

    expect(
      resolveProviderRequestCapabilities({
        api: "anthropic-messages",
        capability: "llm",
        provider: "anthropic",
        transport: "stream",
      }),
    ).toMatchObject({
      allowsAnthropicServiceTier: true,
      endpointClass: "default",
    });

    expect(
      resolveProviderRequestCapabilities({
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
        capability: "llm",
        provider: "custom-proxy",
        transport: "stream",
      }),
    ).toMatchObject({
      allowsOpenAIServiceTier: false,
      allowsResponsesStore: false,
      endpointClass: "custom",
      shouldStripResponsesPromptCache: true,
      supportsOpenAIReasoningCompatPayload: false,
      supportsResponsesStoreField: true,
    });
  });

  it("resolves shared compat families and native streaming-usage gates", () => {
    expect(
      resolveProviderRequestCapabilities({
        api: "openai-completions",
        baseUrl: "https://api.moonshot.ai/v1",
        capability: "llm",
        provider: "moonshot",
        transport: "stream",
      }),
    ).toMatchObject({
      compatibilityFamily: "moonshot",
      endpointClass: "moonshot-native",
      supportsNativeStreamingUsageCompat: true,
    });

    expect(
      resolveProviderRequestCapabilities({
        api: "openai-completions",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        capability: "llm",
        provider: "qwen",
        transport: "stream",
      }),
    ).toMatchObject({
      endpointClass: "modelstudio-native",
      supportsNativeStreamingUsageCompat: true,
    });

    expect(
      resolveProviderRequestCapabilities({
        api: "openai-completions",
        baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
        capability: "llm",
        provider: "generic",
        transport: "stream",
      }),
    ).toMatchObject({
      endpointClass: "modelstudio-native",
      supportsNativeStreamingUsageCompat: true,
    });

    expect(
      resolveProviderRequestCapabilities({
        capability: "llm",
        modelId: "kimi-k2.5:cloud",
        provider: "ollama",
        transport: "stream",
      }),
    ).toMatchObject({
      compatibilityFamily: "moonshot",
    });
  });

  it("treats native GitHub Copilot base URLs as known native endpoints", () => {
    expect(
      resolveProviderRequestCapabilities({
        api: "openai-responses",
        baseUrl: "https://api.individual.githubcopilot.com",
        capability: "llm",
        provider: "github-copilot",
        transport: "http",
      }),
    ).toMatchObject({
      endpointClass: "github-copilot-native",
      isKnownNativeEndpoint: true,
      knownProviderFamily: "github-copilot",
    });
  });

  it("resolves a provider capability matrix for representative native and proxied routes", () => {
    const cases = [
      {
        expected: {
          allowsAnthropicServiceTier: false,
          allowsOpenAIServiceTier: true,
          allowsResponsesStore: true,
          endpointClass: "openai-public",
          isKnownNativeEndpoint: true,
          knownProviderFamily: "openai-family",
          shouldStripResponsesPromptCache: false,
          supportsNativeStreamingUsageCompat: false,
          supportsOpenAIReasoningCompatPayload: true,
          supportsResponsesStoreField: true,
        },
        input: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          capability: "llm" as const,
          provider: "openai",
          transport: "stream" as const,
        },
        name: "native OpenAI responses",
      },
      {
        expected: {
          allowsAnthropicServiceTier: false,
          allowsOpenAIServiceTier: false,
          allowsResponsesStore: false,
          endpointClass: "custom",
          isKnownNativeEndpoint: false,
          knownProviderFamily: "openai-family",
          shouldStripResponsesPromptCache: true,
          supportsNativeStreamingUsageCompat: false,
          supportsOpenAIReasoningCompatPayload: false,
          supportsResponsesStoreField: true,
        },
        input: {
          api: "openai-responses",
          baseUrl: "https://proxy.example.com/v1",
          capability: "llm" as const,
          provider: "openai",
          transport: "stream" as const,
        },
        name: "proxied OpenAI responses",
      },
      {
        expected: {
          allowsAnthropicServiceTier: true,
          allowsOpenAIServiceTier: false,
          allowsResponsesStore: false,
          endpointClass: "anthropic-public",
          isKnownNativeEndpoint: true,
          knownProviderFamily: "anthropic",
          shouldStripResponsesPromptCache: false,
          supportsNativeStreamingUsageCompat: false,
          supportsOpenAIReasoningCompatPayload: false,
          supportsResponsesStoreField: false,
        },
        input: {
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com/v1",
          capability: "llm" as const,
          provider: "anthropic",
          transport: "stream" as const,
        },
        name: "direct Anthropic messages",
      },
      {
        expected: {
          allowsAnthropicServiceTier: false,
          endpointClass: "custom",
          isKnownNativeEndpoint: false,
          supportsNativeStreamingUsageCompat: false,
          supportsOpenAIReasoningCompatPayload: false,
          supportsResponsesStoreField: false,
        },
        input: {
          api: "anthropic-messages",
          baseUrl: "https://proxy.example.com/anthropic",
          capability: "llm" as const,
          provider: "custom-anthropic",
          transport: "stream" as const,
        },
        name: "proxied custom anthropic api",
      },
      {
        expected: {
          allowsAnthropicServiceTier: false,
          allowsOpenAIServiceTier: false,
          allowsResponsesStore: false,
          endpointClass: "openrouter",
          isKnownNativeEndpoint: true,
          knownProviderFamily: "openrouter",
          shouldStripResponsesPromptCache: true,
          supportsNativeStreamingUsageCompat: false,
          supportsOpenAIReasoningCompatPayload: false,
          supportsResponsesStoreField: true,
        },
        input: {
          api: "openai-responses",
          baseUrl: "https://openrouter.ai/api/v1",
          capability: "llm" as const,
          provider: "openrouter",
          transport: "stream" as const,
        },
        name: "native OpenRouter responses",
      },
      {
        expected: {
          allowsAnthropicServiceTier: false,
          allowsOpenAIServiceTier: false,
          allowsResponsesStore: false,
          compatibilityFamily: "moonshot",
          endpointClass: "moonshot-native",
          isKnownNativeEndpoint: true,
          knownProviderFamily: "moonshot",
          shouldStripResponsesPromptCache: false,
          supportsNativeStreamingUsageCompat: true,
          supportsOpenAIReasoningCompatPayload: false,
          supportsResponsesStoreField: false,
        },
        input: {
          api: "openai-completions",
          baseUrl: "https://api.moonshot.ai/v1",
          capability: "llm" as const,
          provider: "moonshot",
          transport: "stream" as const,
        },
        name: "native Moonshot completions",
      },
      {
        expected: {
          allowsAnthropicServiceTier: false,
          allowsOpenAIServiceTier: false,
          allowsResponsesStore: false,
          endpointClass: "modelstudio-native",
          isKnownNativeEndpoint: true,
          knownProviderFamily: "modelstudio",
          shouldStripResponsesPromptCache: false,
          supportsNativeStreamingUsageCompat: true,
          supportsOpenAIReasoningCompatPayload: false,
          supportsResponsesStoreField: false,
        },
        input: {
          api: "openai-completions",
          baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
          capability: "llm" as const,
          provider: "qwen",
          transport: "stream" as const,
        },
        name: "native Qwen completions",
      },
      {
        expected: {
          allowsAnthropicServiceTier: false,
          allowsOpenAIServiceTier: false,
          allowsResponsesStore: false,
          endpointClass: "modelstudio-native",
          isKnownNativeEndpoint: true,
          knownProviderFamily: "generic",
          shouldStripResponsesPromptCache: false,
          supportsNativeStreamingUsageCompat: true,
          supportsOpenAIReasoningCompatPayload: false,
          supportsResponsesStoreField: false,
        },
        input: {
          api: "openai-completions",
          baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
          capability: "llm" as const,
          provider: "generic",
          transport: "stream" as const,
        },
        name: "generic provider on native DashScope completions",
      },
      {
        expected: {
          allowsAnthropicServiceTier: false,
          allowsOpenAIServiceTier: false,
          allowsResponsesStore: false,
          endpointClass: "google-generative-ai",
          isKnownNativeEndpoint: true,
          knownProviderFamily: "google",
          shouldStripResponsesPromptCache: false,
          supportsNativeStreamingUsageCompat: false,
          supportsOpenAIReasoningCompatPayload: false,
          supportsResponsesStoreField: false,
        },
        input: {
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com",
          capability: "llm" as const,
          provider: "google",
          transport: "stream" as const,
        },
        name: "native Google Gemini api",
      },
      {
        expected: {
          allowsAnthropicServiceTier: false,
          allowsOpenAIServiceTier: false,
          allowsResponsesStore: false,
          endpointClass: "github-copilot-native",
          isKnownNativeEndpoint: true,
          knownProviderFamily: "github-copilot",
          shouldStripResponsesPromptCache: true,
          supportsNativeStreamingUsageCompat: false,
          supportsOpenAIReasoningCompatPayload: false,
          supportsResponsesStoreField: true,
        },
        input: {
          api: "openai-responses",
          baseUrl: "https://api.individual.githubcopilot.com",
          capability: "llm" as const,
          provider: "github-copilot",
          transport: "stream" as const,
        },
        name: "native GitHub Copilot responses",
      },
    ];

    for (const testCase of cases) {
      expect(resolveProviderRequestCapabilities(testCase.input), testCase.name).toMatchObject(
        testCase.expected,
      );
    }
  });
});
