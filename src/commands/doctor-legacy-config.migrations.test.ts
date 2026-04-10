import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

let normalizeCompatibilityConfigValues: typeof import("./doctor-legacy-config.js").normalizeCompatibilityConfigValues;
let clearPluginSetupRegistryCache: typeof import("../plugins/setup-registry.js").clearPluginSetupRegistryCache;

function asLegacyConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function getLegacyProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
describe("normalizeCompatibilityConfigValues", () => {
  let previousOauthDir: string | undefined;
  let tempOauthDir: string | undefined;

  const writeCreds = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ me: {} }));
  };

  const expectNoWhatsAppConfigForLegacyAuth = (setup?: () => void) => {
    setup?.();
    const res = normalizeCompatibilityConfigValues({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
    });
    expect(res.config.channels?.whatsapp).toBeUndefined();
    expect(res.changes).toEqual([]);
  };

  beforeEach(() => {
    vi.doUnmock("./doctor-legacy-config.js");
    vi.doUnmock("openclaw/plugin-sdk/text-runtime");
    vi.resetModules();
    previousOauthDir = process.env.OPENCLAW_OAUTH_DIR;
    tempOauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oauth-"));
    process.env.OPENCLAW_OAUTH_DIR = tempOauthDir;
  });

  beforeEach(async () => {
    ({ normalizeCompatibilityConfigValues } = await import("./doctor-legacy-config.js"));
    ({ clearPluginSetupRegistryCache } = await import("../plugins/setup-registry.js"));
    clearPluginSetupRegistryCache();
  });

  afterEach(() => {
    if (previousOauthDir === undefined) {
      delete process.env.OPENCLAW_OAUTH_DIR;
    } else {
      process.env.OPENCLAW_OAUTH_DIR = previousOauthDir;
    }
    if (tempOauthDir) {
      fs.rmSync(tempOauthDir, { force: true, recursive: true });
      tempOauthDir = undefined;
    }
  });

  it("does not add whatsapp config when missing and no auth exists", () => {
    const res = normalizeCompatibilityConfigValues({
      messages: { ackReaction: "👀" },
    });

    expect(res.config.channels?.whatsapp).toBeUndefined();
    expect(res.changes).toEqual([]);
  });

  it("copies legacy ack reaction when whatsapp config exists", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: { whatsapp: {} },
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
    });

    expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
      direct: false,
      emoji: "👀",
      group: "mentions",
    });
    expect(res.changes).toEqual([
      "Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: group-mentions).",
    ]);
  });

  it("does not add whatsapp config when only auth exists (issue #900)", () => {
    expectNoWhatsAppConfigForLegacyAuth(() => {
      const credsDir = path.join(tempOauthDir ?? "", "whatsapp", "default");
      writeCreds(credsDir);
    });
  });

  it("does not add whatsapp config when only legacy auth exists (issue #900)", () => {
    expectNoWhatsAppConfigForLegacyAuth(() => {
      const credsPath = path.join(tempOauthDir ?? "", "creds.json");
      fs.writeFileSync(credsPath, JSON.stringify({ me: {} }));
    });
  });

  it("does not add whatsapp config when only non-default auth exists (issue #900)", () => {
    expectNoWhatsAppConfigForLegacyAuth(() => {
      const credsDir = path.join(tempOauthDir ?? "", "whatsapp", "work");
      writeCreds(credsDir);
    });
  });

  it("copies legacy ack reaction when authDir override exists", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-auth-"));
    try {
      writeCreds(customDir);

      const res = normalizeCompatibilityConfigValues({
        channels: { whatsapp: { accounts: { work: { authDir: customDir } } } },
        messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
      });

      expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
        direct: false,
        emoji: "👀",
        group: "mentions",
      });
      expect(res.changes).toEqual([
        "Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: group-mentions).",
      ]);
    } finally {
      fs.rmSync(customDir, { force: true, recursive: true });
    }
  });

  it("migrates Slack dm.policy/dm.allowFrom to dmPolicy/allowFrom aliases", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        slack: {
          dm: { allowFrom: ["*"], enabled: true, policy: "open" },
        },
      },
    });

    expect(res.config.channels?.slack?.dmPolicy).toBe("open");
    expect(res.config.channels?.slack?.allowFrom).toEqual(["*"]);
    expect(res.config.channels?.slack?.dm).toEqual({
      enabled: true,
    });
    expect(res.changes).toEqual([
      "Moved channels.slack.dm.policy → channels.slack.dmPolicy.",
      "Moved channels.slack.dm.allowFrom → channels.slack.allowFrom.",
    ]);
  });

  it("migrates legacy x_search auth into xai plugin-owned config", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        web: {
          x_search: {
            apiKey: "xai-legacy-key",
            enabled: true,
            model: "grok-4-1-fast",
          },
        } as Record<string, unknown>,
      },
    });

    expect((res.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(res.config.plugins?.entries?.xai).toEqual({
      config: {
        webSearch: {
          apiKey: "xai-legacy-key",
        },
      },
      enabled: true,
    });
    expect(res.changes).toEqual(
      expect.arrayContaining([
        "Moved tools.web.x_search.apiKey → plugins.entries.xai.config.webSearch.apiKey.",
      ]),
    );
  });

  it("migrates legacy voice-call config keys into canonical provider config", () => {
    const res = normalizeCompatibilityConfigValues({
      plugins: {
        entries: {
          "voice-call": {
            config: {
              provider: "log",
              streaming: {
                enabled: true,
                sttProvider: "openai",
                openaiApiKey: "sk-test", // Pragma: allowlist secret
                sttModel: "gpt-4o-transcribe",
                silenceDurationMs: 700,
                vadThreshold: 0.4,
              },
              twilio: {
                from: "+15550001234",
              },
            },
            enabled: true,
          },
        },
      },
    });

    expect(res.config.plugins?.entries?.["voice-call"]?.config).toEqual({
      fromNumber: "+15550001234",
      provider: "mock",
      streaming: {
        enabled: true,
        provider: "openai",
        providers: {
          openai: {
            apiKey: "sk-test",
            model: "gpt-4o-transcribe",
            silenceDurationMs: 700,
            vadThreshold: 0.4,
          },
        },
      },
      twilio: {},
    });
    expect(res.changes).toEqual(
      expect.arrayContaining([
        'Moved plugins.entries.voice-call.config.provider "log" → "mock".',
        "Moved plugins.entries.voice-call.config.twilio.from → plugins.entries.voice-call.config.fromNumber.",
        "Moved plugins.entries.voice-call.config.streaming.sttProvider → plugins.entries.voice-call.config.streaming.provider.",
        "Moved plugins.entries.voice-call.config.streaming.openaiApiKey → plugins.entries.voice-call.config.streaming.providers.openai.apiKey.",
        "Moved plugins.entries.voice-call.config.streaming.sttModel → plugins.entries.voice-call.config.streaming.providers.openai.model.",
        "Moved plugins.entries.voice-call.config.streaming.silenceDurationMs → plugins.entries.voice-call.config.streaming.providers.openai.silenceDurationMs.",
        "Moved plugins.entries.voice-call.config.streaming.vadThreshold → plugins.entries.voice-call.config.streaming.providers.openai.vadThreshold.",
      ]),
    );
  });

  it("migrates legacy Bedrock discovery config into plugin-owned discovery config", () => {
    const res = normalizeCompatibilityConfigValues({
      models: {
        bedrockDiscovery: {
          enabled: true,
          providerFilter: ["anthropic"],
          region: "us-east-1",
        },
        mode: "merge",
      },
    });

    expect(res.config.models).toEqual({
      mode: "merge",
    });
    expect(res.config.plugins?.entries?.["amazon-bedrock"]).toEqual({
      config: {
        discovery: {
          enabled: true,
          providerFilter: ["anthropic"],
          region: "us-east-1",
        },
      },
    });
    expect(res.changes).toEqual(
      expect.arrayContaining([
        "Moved models.bedrockDiscovery → plugins.entries.amazon-bedrock.config.discovery.",
      ]),
    );
  });

  it("migrates Discord account dm.policy/dm.allowFrom to dmPolicy/allowFrom aliases", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        discord: {
          accounts: {
            work: {
              dm: { allowFrom: ["123"], groupEnabled: true, policy: "allowlist" },
            },
          },
        },
      },
    });

    expect(res.config.channels?.discord?.accounts?.work?.dmPolicy).toBe("allowlist");
    expect(res.config.channels?.discord?.accounts?.work?.allowFrom).toEqual(["123"]);
    expect(res.config.channels?.discord?.accounts?.work?.dm).toEqual({
      groupEnabled: true,
    });
    expect(res.changes).toEqual([
      "Moved channels.discord.accounts.work.dm.policy → channels.discord.accounts.work.dmPolicy.",
      "Moved channels.discord.accounts.work.dm.allowFrom → channels.discord.accounts.work.allowFrom.",
    ]);
  });

  it("migrates Discord streaming boolean alias into nested streaming.mode", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          discord: {
            accounts: {
              work: {
                streaming: false,
              },
            },
            streaming: true,
          },
        },
      }),
    );

    expect(res.config.channels?.discord?.streaming).toEqual({ mode: "partial" });
    expect(getLegacyProperty(res.config.channels?.discord, "streamMode")).toBeUndefined();
    expect(res.config.channels?.discord?.accounts?.work?.streaming).toEqual({ mode: "off" });
    expect(
      getLegacyProperty(res.config.channels?.discord?.accounts?.work, "streamMode"),
    ).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streaming (boolean) → channels.discord.streaming.mode (partial).",
      "Moved channels.discord.accounts.work.streaming (boolean) → channels.discord.accounts.work.streaming.mode (off).",
    ]);
  });

  it("migrates Discord legacy streamMode into nested streaming.mode", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          discord: {
            streamMode: "block",
            streaming: false,
          },
        },
      }),
    );

    expect(res.config.channels?.discord?.streaming).toEqual({ mode: "block" });
    expect(getLegacyProperty(res.config.channels?.discord, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streamMode → channels.discord.streaming.mode (block).",
    ]);
  });

  it("migrates Telegram streamMode into nested streaming.mode", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          telegram: {
            streamMode: "block",
          },
        },
      }),
    );

    expect(res.config.channels?.telegram?.streaming).toEqual({ mode: "block" });
    expect(getLegacyProperty(res.config.channels?.telegram, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.telegram.streamMode → channels.telegram.streaming.mode (block).",
    ]);
  });

  it("migrates Slack legacy streaming keys into nested streaming config", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          slack: {
            streamMode: "status_final",
            streaming: false,
          },
        },
      }),
    );

    expect(res.config.channels?.slack?.streaming).toEqual({
      mode: "progress",
      nativeTransport: false,
    });
    expect(getLegacyProperty(res.config.channels?.slack, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.slack.streamMode → channels.slack.streaming.mode (progress).",
      "Moved channels.slack.streaming (boolean) → channels.slack.streaming.nativeTransport.",
    ]);
  });

  it("preserves top-level Telegram allowlist fallback for existing named accounts", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        telegram: {
          accounts: {
            bot1: {
              botToken: "bot-1-token",
              enabled: true,
            },
            bot2: {
              botToken: "bot-2-token",
              enabled: true,
            },
          },
          allowFrom: ["123"],
          dmPolicy: "allowlist",
          enabled: true,
          groupPolicy: "allowlist",
        },
      },
    });

    expect(res.config.channels?.telegram?.dmPolicy).toBe("allowlist");
    expect(res.config.channels?.telegram?.allowFrom).toEqual(["123"]);
    expect(res.config.channels?.telegram?.groupPolicy).toBe("allowlist");
    expect(res.config.channels?.telegram?.accounts?.bot1?.botToken).toBe("bot-1-token");
    expect(res.config.channels?.telegram?.accounts?.bot2?.botToken).toBe("bot-2-token");
    expect(res.changes).not.toContain(
      "Moved channels.telegram single-account top-level values into channels.telegram.accounts.default.",
    );
  });

  it("keeps Telegram policy fallback top-level while still seeding default auth", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        telegram: {
          accounts: {
            bot1: {
              botToken: "bot-1-token",
              enabled: true,
            },
          },
          allowFrom: ["123"],
          botToken: "legacy-token",
          dmPolicy: "allowlist",
          enabled: true,
          groupPolicy: "allowlist",
        },
      },
    });

    expect(res.config.channels?.telegram?.accounts?.default).toMatchObject({
      botToken: "legacy-token",
    });
    expect(res.config.channels?.telegram?.botToken).toBeUndefined();
    expect(res.config.channels?.telegram?.dmPolicy).toBe("allowlist");
    expect(res.config.channels?.telegram?.allowFrom).toEqual(["123"]);
    expect(res.config.channels?.telegram?.groupPolicy).toBe("allowlist");
    expect(res.changes).toContain(
      "Moved channels.telegram single-account top-level values into channels.telegram.accounts.default.",
    );
  });

  it("migrates browser ssrfPolicy allowPrivateNetwork to dangerouslyAllowPrivateNetwork", () => {
    const res = normalizeCompatibilityConfigValues({
      browser: {
        ssrfPolicy: {
          allowPrivateNetwork: true,
          allowedHostnames: ["localhost"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(
      (res.config.browser?.ssrfPolicy as Record<string, unknown> | undefined)?.allowPrivateNetwork,
    ).toBeUndefined();
    expect(res.config.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork).toBe(true);
    expect(res.config.browser?.ssrfPolicy?.allowedHostnames).toEqual(["localhost"]);
    expect(res.changes).toContain(
      "Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (true).",
    );
  });

  it("normalizes conflicting browser SSRF alias keys without changing effective behavior", () => {
    const res = normalizeCompatibilityConfigValues({
      browser: {
        ssrfPolicy: {
          allowPrivateNetwork: true,
          dangerouslyAllowPrivateNetwork: false,
        },
      },
    } as unknown as OpenClawConfig);

    expect(
      (res.config.browser?.ssrfPolicy as Record<string, unknown> | undefined)?.allowPrivateNetwork,
    ).toBeUndefined();
    expect(res.config.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork).toBe(true);
    expect(res.changes).toContain(
      "Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (true).",
    );
  });

  it("migrates nano-banana skill config to native image generation config", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        entries: {
          "nano-banana-pro": {
            apiKey: { id: "GEMINI_API_KEY", provider: "default", source: "env" },
            enabled: true,
          },
        },
      },
    });

    expect(res.config.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "google/gemini-3-pro-image-preview",
    });
    expect(res.config.models?.providers?.google?.apiKey).toEqual({
      id: "GEMINI_API_KEY",
      provider: "default",
      source: "env",
    });
    expect(res.config.models?.providers?.google?.baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(res.config.models?.providers?.google?.models).toEqual([]);
    expect(res.config.skills?.entries).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved skills.entries.nano-banana-pro → agents.defaults.imageGenerationModel.primary (google/gemini-3-pro-image-preview).",
      "Moved skills.entries.nano-banana-pro.apiKey → models.providers.google.apiKey.",
      "Removed legacy skills.entries.nano-banana-pro.",
    ]);
  });

  it("prefers legacy nano-banana env.GEMINI_API_KEY over skill apiKey during migration", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        entries: {
          "nano-banana-pro": {
            apiKey: "ignored-skill-api-key",
            env: {
              GEMINI_API_KEY: "env-gemini-key",
            },
          },
        },
      },
    });

    expect(res.config.models?.providers?.google?.apiKey).toBe("env-gemini-key");
    expect(res.config.models?.providers?.google?.baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(res.config.models?.providers?.google?.models).toEqual([]);
    expect(res.changes).toContain(
      "Moved skills.entries.nano-banana-pro.env.GEMINI_API_KEY → models.providers.google.apiKey.",
    );
  });

  it("preserves explicit native config while removing legacy nano-banana skill config", () => {
    const res = normalizeCompatibilityConfigValues({
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "fal/fal-ai/flux/dev",
          },
        },
      },
      models: {
        providers: {
          google: {
            apiKey: "existing-google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [],
          },
        },
      },
      skills: {
        entries: {
          "nano-banana-pro": {
            apiKey: "legacy-gemini-key",
          },
          peekaboo: { enabled: true },
        },
      },
    });

    expect(res.config.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "fal/fal-ai/flux/dev",
    });
    expect(res.config.models?.providers?.google?.apiKey).toBe("existing-google-key");
    expect(res.config.skills?.entries).toEqual({
      peekaboo: { enabled: true },
    });
    expect(res.changes).toEqual(["Removed legacy skills.entries.nano-banana-pro."]);
  });

  it("removes nano-banana from skills.allowBundled during migration", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        allowBundled: ["peekaboo", "nano-banana-pro"],
      },
    });

    expect(res.config.skills?.allowBundled).toEqual(["peekaboo"]);
    expect(res.changes).toEqual(["Removed nano-banana-pro from skills.allowBundled."]);
  });

  it("migrates legacy web search provider config to plugin-owned config paths", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        web: {
          search: {
            apiKey: "brave-key",
            firecrawl: {
              apiKey: "firecrawl-key",
              baseUrl: "https://api.firecrawl.dev",
            },
            gemini: {
              apiKey: "gemini-key",
              model: "gemini-2.5-flash",
            },
            maxResults: 5,
            provider: "gemini",
          },
        },
      },
    });

    expect(res.config.tools?.web?.search).toEqual({
      maxResults: 5,
      provider: "gemini",
    });
    expect(res.config.plugins?.entries?.brave).toEqual({
      config: {
        webSearch: {
          apiKey: "brave-key",
        },
      },
      enabled: true,
    });
    expect(res.config.plugins?.entries?.google).toEqual({
      config: {
        webSearch: {
          apiKey: "gemini-key",
          model: "gemini-2.5-flash",
        },
      },
      enabled: true,
    });
    expect(res.config.plugins?.entries?.firecrawl).toEqual({
      config: {
        webSearch: {
          apiKey: "firecrawl-key",
          baseUrl: "https://api.firecrawl.dev",
        },
      },
      enabled: true,
    });
    expect(res.changes).toEqual([
      "Moved tools.web.search.apiKey → plugins.entries.brave.config.webSearch.apiKey.",
      "Moved tools.web.search.firecrawl → plugins.entries.firecrawl.config.webSearch.",
      "Moved tools.web.search.gemini → plugins.entries.google.config.webSearch.",
    ]);
  });

  it("merges legacy web search provider config into explicit plugin config without overriding it", () => {
    const res = normalizeCompatibilityConfigValues({
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                baseUrl: "https://generativelanguage.googleapis.com",
                model: "explicit-model",
              },
            },
            enabled: true,
          },
        },
      },
      tools: {
        web: {
          search: {
            gemini: {
              apiKey: "legacy-gemini-key",
              model: "legacy-model",
            },
            provider: "gemini",
          },
        },
      },
    });

    expect(res.config.tools?.web?.search).toEqual({
      provider: "gemini",
    });
    expect(res.config.plugins?.entries?.google).toEqual({
      config: {
        webSearch: {
          apiKey: "legacy-gemini-key",
          baseUrl: "https://generativelanguage.googleapis.com",
          model: "explicit-model",
        },
      },
      enabled: true,
    });
    expect(res.changes).toEqual([
      "Merged tools.web.search.gemini → plugins.entries.google.config.webSearch (filled missing fields from legacy; kept explicit plugin config values).",
    ]);
  });

  it("migrates legacy web fetch provider config to plugin-owned config paths", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        web: {
          fetch: {
            firecrawl: {
              apiKey: "firecrawl-key",
              baseUrl: "https://api.firecrawl.dev",
              onlyMainContent: false,
            },
            provider: "firecrawl",
            timeoutSeconds: 15,
          },
        },
      },
    } as OpenClawConfig);

    expect(res.config.tools?.web?.fetch).toEqual({
      provider: "firecrawl",
      timeoutSeconds: 15,
    });
    expect(res.config.plugins?.entries?.firecrawl).toEqual({
      config: {
        webFetch: {
          apiKey: "firecrawl-key",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: false,
        },
      },
      enabled: true,
    });
    expect(res.changes).toEqual([
      "Moved tools.web.fetch.firecrawl → plugins.entries.firecrawl.config.webFetch.",
    ]);
  });

  it("keeps explicit plugin-owned web fetch config while filling missing legacy fields", () => {
    const res = normalizeCompatibilityConfigValues({
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: "explicit-firecrawl-key",
                timeoutSeconds: 30,
              },
            },
            enabled: true,
          },
        },
      },
      tools: {
        web: {
          fetch: {
            firecrawl: {
              apiKey: "legacy-firecrawl-key",
              baseUrl: "https://api.firecrawl.dev",
              onlyMainContent: false,
            },
            provider: "firecrawl",
          },
        },
      },
    } as OpenClawConfig);

    expect(res.config.plugins?.entries?.firecrawl).toEqual({
      config: {
        webFetch: {
          apiKey: "explicit-firecrawl-key",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: false,
          timeoutSeconds: 30,
        },
      },
      enabled: true,
    });
    expect(res.changes).toEqual([
      "Merged tools.web.fetch.firecrawl → plugins.entries.firecrawl.config.webFetch (filled missing fields from legacy; kept explicit plugin config values).",
    ]);
  });

  it("migrates legacy talk flat fields to provider/providers", () => {
    const res = normalizeCompatibilityConfigValues({
      talk: {
        apiKey: "secret-key",
        interruptOnSpeech: false,
        modelId: "eleven_v3",
        outputFormat: "pcm_44100",
        silenceTimeoutMs: 1500,
        voiceAliases: {
          Clawd: "VoiceAlias1234567890",
        },
        voiceId: "voice-123",
      },
    } as unknown as OpenClawConfig);

    expect(res.config.talk).toEqual({
      interruptOnSpeech: false,
      providers: {
        elevenlabs: {
          apiKey: "secret-key",
          modelId: "eleven_v3",
          outputFormat: "pcm_44100",
          voiceAliases: {
            Clawd: "VoiceAlias1234567890",
          },
          voiceId: "voice-123",
        },
      },
      silenceTimeoutMs: 1500,
    });
    expect(res.changes).toEqual([
      "Moved talk legacy fields (voiceId, voiceAliases, modelId, outputFormat, apiKey) → talk.providers.elevenlabs (filled missing provider fields only).",
    ]);
  });

  it("normalizes talk provider ids without overriding explicit provider config", () => {
    const res = normalizeCompatibilityConfigValues({
      talk: {
        apiKey: "secret-key",
        provider: " elevenlabs ",
        providers: {
          " elevenlabs ": {
            voiceId: "voice-123",
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(res.config.talk).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          apiKey: "secret-key",
          voiceId: "voice-123",
        },
      },
    });
    expect(res.changes).toEqual([
      "Moved talk legacy fields (apiKey) → talk.providers.elevenlabs (filled missing provider fields only).",
      "Normalized talk.provider/providers shape (trimmed provider ids and merged missing compatibility fields).",
    ]);
  });

  it("does not report talk provider normalization for semantically identical key ordering differences", () => {
    const input = {
      talk: {
        interruptOnSpeech: true,
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "secret-key",
            modelId: "eleven_v3",
            voiceId: "voice-123",
          },
        },
        silenceTimeoutMs: 1500,
      },
    };

    const res = normalizeCompatibilityConfigValues(input);

    expect(res.config).toEqual(input);
    expect(res.changes).toEqual([]);
  });

  it("migrates tools.message.allowCrossContextSend to canonical crossContext settings", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        message: {
          allowCrossContextSend: true,
          crossContext: {
            allowAcrossProviders: false,
            allowWithinProvider: false,
          },
        },
      },
    });

    expect(res.config.tools?.message).toEqual({
      crossContext: {
        allowAcrossProviders: true,
        allowWithinProvider: true,
      },
    });
    expect(res.changes).toEqual([
      "Moved tools.message.allowCrossContextSend → tools.message.crossContext.allowWithinProvider/allowAcrossProviders (true).",
    ]);
  });

  it("migrates legacy deepgram media options to providerOptions.deepgram", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        media: {
          audio: {
            deepgram: {
              detectLanguage: true,
              smartFormat: true,
            },
            models: [
              {
                deepgram: {
                  punctuate: true,
                },
                provider: "deepgram",
              },
            ],
            providerOptions: {
              deepgram: {
                punctuate: false,
              },
            },
          },
          models: [
            {
              deepgram: {
                smartFormat: false,
              },
              provider: "deepgram",
              providerOptions: {
                deepgram: {
                  detect_language: true,
                },
              },
            },
          ],
        },
      },
    });

    expect(res.config.tools?.media?.audio).toEqual({
      models: [
        {
          provider: "deepgram",
          providerOptions: {
            deepgram: {
              punctuate: true,
            },
          },
        },
      ],
      providerOptions: {
        deepgram: {
          detect_language: true,
          punctuate: false,
          smart_format: true,
        },
      },
    });
    expect(res.config.tools?.media?.models).toEqual([
      {
        provider: "deepgram",
        providerOptions: {
          deepgram: {
            detect_language: true,
            smart_format: false,
          },
        },
      },
    ]);
    expect(res.changes).toEqual([
      "Merged tools.media.audio.deepgram → tools.media.audio.providerOptions.deepgram (filled missing canonical fields from legacy).",
      "Moved tools.media.audio.models[0].deepgram → tools.media.audio.models[0].providerOptions.deepgram.",
      "Merged tools.media.models[0].deepgram → tools.media.models[0].providerOptions.deepgram (filled missing canonical fields from legacy).",
    ]);
  });

  it("normalizes persisted mistral model maxTokens that matched the old context-sized defaults", () => {
    const res = normalizeCompatibilityConfigValues({
      models: {
        providers: {
          mistral: {
            api: "openai-completions",
            baseUrl: "https://api.mistral.ai/v1",
            models: [
              {
                contextWindow: 262144,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "mistral-large-latest",
                input: ["text", "image"],
                maxTokens: 262144,
                name: "Mistral Large",
                reasoning: false,
              },
              {
                contextWindow: 128000,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "magistral-small",
                input: ["text"],
                maxTokens: 128000,
                name: "Magistral Small",
                reasoning: true,
              },
            ],
          },
        },
      },
    });

    expect(res.config.models?.providers?.mistral?.models).toEqual([
      expect.objectContaining({
        id: "mistral-large-latest",
        maxTokens: 16_384,
      }),
      expect.objectContaining({
        id: "magistral-small",
        maxTokens: 40_000,
      }),
    ]);
    expect(res.changes).toEqual([
      "Normalized models.providers.mistral.models[0].maxTokens (262144 → 16384) to avoid Mistral context-window rejects.",
      "Normalized models.providers.mistral.models[1].maxTokens (128000 → 40000) to avoid Mistral context-window rejects.",
    ]);
  });
});
