import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { MODEL_CONTEXT_TOKEN_CACHE } from "../agents/context-cache.js";
import type { OpenClawConfig } from "../config/config.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { createSuccessfulImageMediaDecision } from "./media-understanding.test-fixtures.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  buildStatusMessage as buildStatusMessageRaw,
} from "./status.js";
import type { buildStatusMessage as BuildStatusMessage } from "./status.js";

const buildStatusMessage: typeof BuildStatusMessage = (args) =>
  buildStatusMessageRaw({
    activeModelAuth: "api-key",
    modelAuth: "api-key",
    ...args,
  });

const { listPluginCommands } = vi.hoisted(() => ({
  listPluginCommands: vi.fn((): { name: string; description: string; pluginId: string }[] => []),
}));

vi.mock("../plugins/commands.js", () => ({
  listPluginCommands,
}));

afterEach(() => {
  vi.restoreAllMocks();
  MODEL_CONTEXT_TOKEN_CACHE.clear();
});

describe("buildStatusMessage", () => {
  it("summarizes agent readiness and context usage", () => {
    const text = buildStatusMessage({
      agent: {
        contextTokens: 32_000,
        model: "anthropic/pi:opus",
      },
      config: {
        models: {
          providers: {
            anthropic: {
              apiKey: "test-key",
              models: [
                {
                  cost: {
                    cacheRead: 0,
                    cacheWrite: 0,
                    input: 1,
                    output: 1,
                  },
                  id: "pi:opus",
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      modelAuth: "api-key",
      now: 10 * 60_000,
      queue: { depth: 0, mode: "collect" },
      resolvedThink: "medium",
      resolvedVerbose: "off",
      sessionEntry: {
        compactionCount: 2,
        contextTokens: 32_000,
        inputTokens: 1200,
        outputTokens: 800,
        sessionId: "abc",
        thinkingLevel: "low",
        totalTokens: 16_000,
        updatedAt: 0,
        verboseLevel: "on",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender", // 10 minutes later
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("OpenClaw");
    expect(normalized).toContain("Model: anthropic/pi:opus");
    expect(normalized).toContain("api-key");
    expect(normalized).toContain("Tokens: 1.2k in / 800 out");
    expect(normalized).toContain("Cost: $0.0020");
    expect(normalized).toContain("Context: 16k/32k (50%)");
    expect(normalized).toContain("Compactions: 2");
    expect(normalized).toContain("Session: agent:main:main");
    expect(normalized).toContain("updated 10m ago");
    expect(normalized).toContain("Runtime: direct");
    expect(normalized).toContain("Think: medium");
    expect(normalized).not.toContain("verbose");
    expect(normalized).toContain("elevated");
    expect(normalized).toContain("Queue: collect");
  });

  it("falls back to sessionEntry levels when resolved levels are not passed", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/pi:opus",
      },
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        reasoningLevel: "on",
        sessionId: "abc",
        thinkingLevel: "high",
        updatedAt: 0,
        verboseLevel: "full",
      },
      sessionKey: "agent:main:main",
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("Think: high");
    expect(normalized).toContain("verbose:full");
    expect(normalized).toContain("Reasoning: on");
  });

  it("shows plugin status lines only when verbose is enabled", () => {
    const visible = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/pi:opus",
        },
        queue: { depth: 0, mode: "collect" },
        sessionEntry: {
          pluginDebugEntries: [
            { lines: ["🧩 Active Memory: timeout 15s recent"], pluginId: "active-memory" },
          ],
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "on",
        },
        sessionKey: "agent:main:main",
      }),
    );
    const hidden = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/pi:opus",
        },
        queue: { depth: 0, mode: "collect" },
        sessionEntry: {
          pluginDebugEntries: [
            { lines: ["🧩 Active Memory: timeout 15s recent"], pluginId: "active-memory" },
          ],
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "off",
        },
        sessionKey: "agent:main:main",
      }),
    );

    expect(visible).toContain("Active Memory: timeout 15s recent");
    expect(hidden).not.toContain("Active Memory: timeout 15s recent");
  });

  it("shows structured plugin debug lines in verbose status", () => {
    const visible = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/pi:opus",
        },
        queue: { depth: 0, mode: "collect" },
        sessionEntry: {
          pluginDebugEntries: [
            { lines: ["🧩 Active Memory: ok 842ms recent 34 chars"], pluginId: "active-memory" },
          ],
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "on",
        },
        sessionKey: "agent:main:main",
      }),
    );

    expect(visible).toContain("Active Memory: ok 842ms recent 34 chars");
  });

  it("shows fast mode when enabled", () => {
    const text = buildStatusMessage({
      agent: {
        model: "openai/gpt-5.4",
      },
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        fastMode: true,
        sessionId: "fast",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
    });

    expect(normalizeTestText(text)).toContain("Fast: on");
  });

  it("shows configured text verbosity for the active model", () => {
    const text = buildStatusMessage({
      agent: {
        model: "openai-codex/gpt-5.4",
      },
      config: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.4",
            models: {
              "openai-codex/gpt-5.4": {
                params: {
                  textVerbosity: "low",
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
    });

    expect(normalizeTestText(text)).toContain("Text: low");
  });

  it("shows per-agent text verbosity overrides for the active model", () => {
    const text = buildStatusMessage({
      agent: {
        model: "openai-codex/gpt-5.4",
      },
      agentId: "main",
      config: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.4",
            models: {
              "openai-codex/gpt-5.4": {
                params: {
                  textVerbosity: "high",
                },
              },
            },
          },
          list: [
            {
              id: "main",
              params: {
                text_verbosity: "low",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
    });

    expect(normalizeTestText(text)).toContain("Text: low");
  });

  it("notes channel model overrides in status output", () => {
    const text = buildStatusMessage({
      agent: {
        model: "openai/gpt-4.1",
      },
      config: {
        channels: {
          modelByChannel: {
            discord: {
              "123": "openai/gpt-4.1",
            },
          },
        },
      } as unknown as OpenClawConfig,
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        channel: "discord",
        groupId: "123",
        sessionId: "abc",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("Model: openai/gpt-4.1");
    expect(normalized).toContain("channel override");
  });

  it("shows 1M context window when anthropic context1m is enabled", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      config: {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {
                params: { context1m: true },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        sessionId: "ctx1m",
        totalTokens: 200_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    expect(normalizeTestText(text)).toContain("Context: 200k/1.0m");
  });

  it("recomputes context window from the active model after switching away from a smaller session override", () => {
    const sessionEntry = {
      contextTokens: 4096,
      modelOverride: "small-model",
      providerOverride: "local",
      sessionId: "switch-back",
      totalTokens: 1024,
      updatedAt: 0,
    };

    applyModelOverrideToSessionEntry({
      entry: sessionEntry,
      selection: {
        isDefault: true,
        model: "large-model",
        provider: "local",
      },
    });

    const text = buildStatusMessage({
      agent: {
        contextTokens: 65_536,
        model: "local/large-model",
      },
      queue: { depth: 0, mode: "collect" },
      sessionEntry,
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    expect(normalizeTestText(text)).toContain("Context: 1.0k/66k");
  });

  it("recomputes context window from the active fallback model when session contextTokens are stale", () => {
    const text = buildStatusMessage({
      activeModelAuth: "api-key",
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ contextWindow: 200_000, id: "MiniMax-M2.7" }],
            },
            xiaomi: {
              models: [{ contextWindow: 1_048_576, id: "mimo-v2-flash" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        contextTokens: 1_048_576,
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        model: "MiniMax-M2.7",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        providerOverride: "xiaomi",
        sessionId: "fallback-context-window",
        totalTokens: 49_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/200k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("keeps an explicit runtime context limit when fallback status already computed one", () => {
    const text = buildStatusMessage({
      activeModelAuth: "api-key",
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ contextWindow: 200_000, id: "MiniMax-M2.7" }],
            },
            xiaomi: {
              models: [{ contextWindow: 1_048_576, id: "mimo-v2-flash" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      runtimeContextTokens: 123_456,
      sessionEntry: {
        contextTokens: 1_048_576,
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        model: "MiniMax-M2.7",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        providerOverride: "xiaomi",
        sessionId: "fallback-context-window-live-limit",
        totalTokens: 49_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/123k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps the persisted runtime context limit for fallback sessions when no live override is passed", () => {
    const text = buildStatusMessage({
      activeModelAuth: "api-key",
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ contextWindow: 200_000, id: "MiniMax-M2.7" }],
            },
            xiaomi: {
              models: [{ contextWindow: 1_048_576, id: "mimo-v2-flash" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        contextTokens: 123_456,
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        model: "MiniMax-M2.7",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        providerOverride: "xiaomi",
        sessionId: "fallback-context-window-persisted-limit",
        totalTokens: 49_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/123k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps an explicit configured context cap for fallback status before runtime snapshot persists", () => {
    const text = buildStatusMessage({
      activeModelAuth: "api-key",
      agent: {
        contextTokens: 120_000,
        model: "xiaomi/mimo-v2-flash",
      },
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ contextWindow: 200_000, id: "MiniMax-M2.7" }],
            },
            xiaomi: {
              models: [{ contextWindow: 1_048_576, id: "mimo-v2-flash" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      explicitConfiguredContextTokens: 120_000,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        model: "MiniMax-M2.7",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        providerOverride: "xiaomi",
        sessionId: "fallback-context-window-configured-cap",
        totalTokens: 49_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/120k");
    expect(normalized).not.toContain("Context: 49k/200k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("keeps an explicit configured context cap even when it matches the selected model window", () => {
    const text = buildStatusMessage({
      activeModelAuth: "api-key",
      agent: {
        contextTokens: 128_000,
        model: "xiaomi/mimo-v2-flash",
      },
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ contextWindow: 200_000, id: "MiniMax-M2.7" }],
            },
            xiaomi: {
              models: [{ contextWindow: 128_000, id: "mimo-v2-flash" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      explicitConfiguredContextTokens: 128_000,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        model: "MiniMax-M2.7",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        providerOverride: "xiaomi",
        sessionId: "fallback-context-window-configured-cap-equals-selected",
        totalTokens: 49_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/128k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("clamps an explicit configured context cap to the active fallback window", () => {
    const text = buildStatusMessage({
      activeModelAuth: "api-key",
      agent: {
        contextTokens: 1_048_576,
        model: "xiaomi/mimo-v2-flash",
      },
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ contextWindow: 200_000, id: "MiniMax-M2.7" }],
            },
            xiaomi: {
              models: [{ contextWindow: 1_048_576, id: "mimo-v2-flash" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      explicitConfiguredContextTokens: 1_048_576,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        model: "MiniMax-M2.7",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        providerOverride: "xiaomi",
        sessionId: "fallback-context-window-configured-cap-clamped",
        totalTokens: 49_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/200k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("keeps a persisted fallback limit when the active runtime model lookup is unavailable", () => {
    const text = buildStatusMessage({
      activeModelAuth: "api-key",
      agent: {
        contextTokens: 1_048_576,
        model: "xiaomi/mimo-v2-flash",
      },
      config: {
        models: {
          providers: {
            xiaomi: {
              models: [{ contextWindow: 1_048_576, id: "mimo-v2-flash" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      explicitConfiguredContextTokens: 1_048_576,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        contextTokens: 128_000,
        fallbackNoticeActiveModel: "custom-runtime/unknown-fallback-model",
        fallbackNoticeReason: "model not allowed",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        model: "unknown-fallback-model",
        modelOverride: "mimo-v2-flash",
        modelProvider: "custom-runtime",
        providerOverride: "xiaomi",
        sessionId: "fallback-context-window-persisted-unknown-active",
        totalTokens: 49_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: custom-runtime/unknown-fallback-model");
    expect(normalized).toContain("Context: 49k/128k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("uses per-agent sandbox config when config and session key are provided", () => {
    const text = buildStatusMessage({
      agent: {},
      config: {
        agents: {
          list: [
            { default: true, id: "main" },
            { id: "discord", sandbox: { mode: "all" } },
          ],
        },
      } as unknown as OpenClawConfig,
      queue: { depth: 0, mode: "collect" },
      sessionKey: "agent:discord:discord:channel:1456350065223270435",
      sessionScope: "per-sender",
    });

    expect(normalizeTestText(text)).toContain("Runtime: docker/all");
  });

  it("shows verbose/elevated labels only when enabled", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      queue: { depth: 0, mode: "collect" },
      resolvedElevated: "on",
      resolvedThink: "low",
      resolvedVerbose: "on",
      sessionEntry: { sessionId: "v1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    expect(text).toContain("verbose");
    expect(text).toContain("elevated");
  });

  it("includes media understanding decisions when present", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      mediaDecisions: [
        createSuccessfulImageMediaDecision() as unknown as NonNullable<
          Parameters<typeof buildStatusMessage>[0]["mediaDecisions"]
        >[number],
        {
          attachments: [
            {
              attachmentIndex: 1,
              attempts: [
                {
                  type: "provider",
                  outcome: "skipped",
                  reason: "maxBytes: too large",
                },
              ],
            },
          ],
          capability: "audio",
          outcome: "skipped",
        },
      ],
      queue: { mode: "none" },
      sessionEntry: { sessionId: "media", updatedAt: 0 },
      sessionKey: "agent:main:main",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Media: image ok (openai/gpt-5.4) · audio skipped (maxBytes)");
  });

  it("omits media line when all decisions are none", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      mediaDecisions: [
        { attachments: [], capability: "image", outcome: "no-attachment" },
        { attachments: [], capability: "audio", outcome: "no-attachment" },
        { attachments: [], capability: "video", outcome: "no-attachment" },
      ],
      queue: { mode: "none" },
      sessionEntry: { sessionId: "media-none", updatedAt: 0 },
      sessionKey: "agent:main:main",
    });

    expect(normalizeTestText(text)).not.toContain("Media:");
  });

  it("does not show elevated label when session explicitly disables it", () => {
    const text = buildStatusMessage({
      agent: { elevatedDefault: "on", model: "anthropic/claude-opus-4-6" },
      queue: { depth: 0, mode: "collect" },
      resolvedThink: "low",
      resolvedVerbose: "off",
      sessionEntry: { elevatedLevel: "off", sessionId: "v1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const optionsLine = text.split("\n").find((line) => line.trim().startsWith("⚙️"));
    expect(optionsLine).toBeTruthy();
    expect(optionsLine).not.toContain("elevated");
  });

  it("shows selected model and active runtime model when they differ", () => {
    const text = buildStatusMessage({
      activeModelAuth: "api-key di_123…abc (deepinfra:default)",
      agent: {
        contextTokens: 32_000,
        model: "anthropic/claude-opus-4-6",
      },
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        contextTokens: 32_000,
        fallbackNoticeActiveModel: "anthropic/claude-haiku-4-5",
        fallbackNoticeReason: "rate limit",
        fallbackNoticeSelectedModel: "openai/gpt-4.1-mini",
        model: "claude-haiku-4-5",
        modelOverride: "gpt-4.1-mini",
        modelProvider: "anthropic",
        providerOverride: "openai",
        sessionId: "override-1",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-4.1-mini");
    expect(normalized).toContain("Fallback: anthropic/claude-haiku-4-5");
    expect(normalized).toContain("(rate limit)");
    expect(normalized).not.toContain(" - Reason:");
    expect(normalized).not.toContain("Active:");
    expect(normalized).toContain("di_123...abc");
  });

  it("omits active fallback details when runtime drift does not match fallback state", () => {
    const text = buildStatusMessage({
      activeModelAuth: "api-key di_123…abc (deepinfra:default)",
      agent: {
        contextTokens: 32_000,
        model: "openai/gpt-4.1-mini",
      },
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        fallbackNoticeActiveModel: "deepinfra/moonshotai/Kimi-K2.5",
        fallbackNoticeReason: "rate limit",
        fallbackNoticeSelectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        model: "claude-haiku-4-5",
        modelProvider: "anthropic",
        sessionId: "runtime-drift-only",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-4.1-mini");
    expect(normalized).not.toContain("Fallback:");
    expect(normalized).not.toContain("(rate limit)");
  });

  it("omits active lines when runtime matches selected model", () => {
    const text = buildStatusMessage({
      agent: {
        contextTokens: 32_000,
        model: "openai/gpt-4.1-mini",
      },
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        fallbackNoticeReason: "unknown",
        model: "gpt-4.1-mini",
        modelProvider: "openai",
        sessionId: "selected-active-same",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).not.toContain("Fallback:");
  });

  it("shows configured fallback models when provided", () => {
    const text = buildStatusMessage({
      agent: {
        model: {
          fallbacks: ["google/gemini-2.5-flash", "openai/gpt-5-mini"],
          primary: "anthropic/claude-opus-4-6",
        },
      },
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: { sessionId: "fb1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallbacks: google/gemini-2.5-flash, openai/gpt-5-mini");
  });

  it("omits configured fallbacks line when no fallbacks provided", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: { sessionId: "fb2", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).not.toContain("Fallbacks:");
  });

  it("keeps provider prefix from configured model", () => {
    const text = buildStatusMessage({
      agent: {
        model: "google-antigravity/claude-sonnet-4-6",
      },
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionScope: "per-sender",
    });

    expect(normalizeTestText(text)).toContain("Model: google-antigravity/claude-sonnet-4-6");
  });

  it("handles missing agent config gracefully", () => {
    const text = buildStatusMessage({
      agent: {},
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model:");
    expect(normalized).toContain("Context:");
    expect(normalized).toContain("Queue: collect");
  });

  it("includes group activation for group sessions", () => {
    const text = buildStatusMessage({
      agent: {},
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        chatType: "group",
        groupActivation: "always",
        sessionId: "g1",
        updatedAt: 0,
      },
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      sessionScope: "per-sender",
    });

    expect(text).toContain("Activation: always");
  });

  it("shows queue details when overridden", () => {
    const text = buildStatusMessage({
      agent: {},
      modelAuth: "api-key",
      queue: {
        cap: 5,
        debounceMs: 2000,
        depth: 3,
        dropPolicy: "old",
        mode: "collect",
        showDetails: true,
      },
      sessionEntry: { sessionId: "q1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    expect(text).toContain("Queue: collect (depth 3 · debounce 2s · cap 5 · drop old)");
  });

  it("inserts usage summary beneath context line", () => {
    const text = buildStatusMessage({
      agent: { contextTokens: 32_000, model: "anthropic/claude-opus-4-6" },
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: { sessionId: "u1", totalTokens: 1000, updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      usageLine: "📊 Usage: Claude 80% left (5h)",
    });

    const lines = normalizeTestText(text).split("\n");
    const contextIndex = lines.findIndex((line) => line.includes("Context:"));
    expect(contextIndex).toBeGreaterThan(-1);
    expect(lines[contextIndex + 1]).toContain("Usage: Claude 80% left (5h)");
  });

  it("hides cost when not using an API key", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      config: {
        models: {
          providers: {
            anthropic: {
              models: [
                {
                  cost: {
                    cacheRead: 0,
                    cacheWrite: 0,
                    input: 1,
                    output: 1,
                  },
                  id: "claude-opus-4-6",
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      modelAuth: "oauth",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: { inputTokens: 10, sessionId: "c1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    expect(text).not.toContain("💵 Cost:");
  });

  function writeTranscriptUsageLog(params: {
    dir: string;
    agentId: string;
    sessionId: string;
    model?: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    };
  }) {
    const logPath = path.join(
      params.dir,
      ".openclaw",
      "agents",
      params.agentId,
      "sessions",
      `${params.sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          message: {
            model: params.model ?? "claude-opus-4-6",
            role: "assistant",
            usage: params.usage,
          },
          type: "message",
        }),
      ].join("\n"),
      "utf8",
    );
  }

  const baselineTranscriptUsage = {
    cacheRead: 1000,
    cacheWrite: 0,
    input: 1,
    output: 2,
    totalTokens: 1003,
  } as const;

  function writeBaselineTranscriptUsageLog(params: {
    dir: string;
    agentId: string;
    sessionId: string;
  }) {
    writeTranscriptUsageLog({
      ...params,
      usage: baselineTranscriptUsage,
    });
  }

  function buildTranscriptStatusText(params: { sessionId: string; sessionKey: string }) {
    return buildStatusMessage({
      agent: {
        contextTokens: 32_000,
        model: "anthropic/claude-opus-4-6",
      },
      includeTranscriptUsage: true,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        contextTokens: 32_000,
        sessionId: params.sessionId,
        totalTokens: 3,
        updatedAt: 0,
      },
      sessionKey: params.sessionKey,
      sessionScope: "per-sender",
    });
  }

  it("prefers cached prompt tokens from the session log", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-1";
        writeBaselineTranscriptUsageLog({
          agentId: "main",
          dir,
          sessionId,
        });

        const text = buildTranscriptStatusText({
          sessionId,
          sessionKey: "agent:main:main",
        });

        expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("reads transcript usage for non-default agents", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-worker1";
        writeBaselineTranscriptUsageLog({
          agentId: "worker1",
          dir,
          sessionId,
        });

        const text = buildTranscriptStatusText({
          sessionId,
          sessionKey: "agent:worker1:telegram:12345",
        });

        expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("reads transcript usage using explicit agentId when sessionKey is missing", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-worker2";
        writeTranscriptUsageLog({
          agentId: "worker2",
          dir,
          sessionId,
          usage: {
            cacheRead: 1200,
            cacheWrite: 0,
            input: 2,
            output: 3,
            totalTokens: 1205,
          },
        });

        const text = buildStatusMessage({
          agent: {
            contextTokens: 32_000,
            model: "anthropic/claude-opus-4-6",
          },
          agentId: "worker2",
          sessionEntry: {
            contextTokens: 32_000,
            sessionId,
            totalTokens: 5,
            updatedAt: 0,
          },
          // Intentionally omitted: sessionKey
          sessionScope: "per-sender",
          queue: { depth: 0, mode: "collect" },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });

        expect(normalizeTestText(text)).toContain("Context: 1.2k/32k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("hydrates cache usage from transcript fallback", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-cache-hydration";
        writeBaselineTranscriptUsageLog({
          agentId: "main",
          dir,
          sessionId,
        });

        const text = buildTranscriptStatusText({
          sessionId,
          sessionKey: "agent:main:main",
        });

        expect(normalizeTestText(text)).toContain("Cache: 100% hit · 1.0k cached, 0 new");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("uses the same transcript usage fallback as sessions.list when a delivery mirror is last", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-cache-delivery-mirror";
        const logPath = path.join(
          dir,
          ".openclaw",
          "agents",
          "main",
          "sessions",
          `${sessionId}.jsonl`,
        );
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(
          logPath,
          [
            JSON.stringify({ id: sessionId, type: "session", version: 1 }),
            JSON.stringify({
              message: {
                model: "claude-opus-4-6",
                provider: "anthropic",
                role: "assistant",
                usage: {
                  cacheRead: 1000,
                  cacheWrite: 0,
                  input: 1,
                  output: 2,
                  totalTokens: 1003,
                },
              },
              type: "message",
            }),
            JSON.stringify({
              message: {
                model: "delivery-mirror",
                provider: "openclaw",
                role: "assistant",
                usage: {
                  cacheRead: 0,
                  cacheWrite: 0,
                  input: 0,
                  output: 0,
                  totalTokens: 0,
                },
              },
              type: "message",
            }),
          ].join("\n"),
          "utf8",
        );

        const text = buildTranscriptStatusText({
          sessionId,
          sessionKey: "agent:main:main",
        });

        expect(normalizeTestText(text)).toContain("Cache: 100% hit · 1.0k cached, 0 new");
        expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("preserves existing nonzero cache usage over transcript fallback values", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-cache-preserve";
        writeBaselineTranscriptUsageLog({
          agentId: "main",
          dir,
          sessionId,
        });

        const text = buildStatusMessage({
          agent: {
            contextTokens: 32_000,
            model: "anthropic/claude-opus-4-6",
          },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
          queue: { depth: 0, mode: "collect" },
          sessionEntry: {
            cacheRead: 12,
            cacheWrite: 34,
            contextTokens: 32_000,
            sessionId,
            totalTokens: 3,
            updatedAt: 0,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
        });

        expect(normalizeTestText(text)).toContain("Cache: 26% hit · 12 cached, 34 new");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("keeps transcript-derived slash model ids on model-only context lookup", async () => {
    await withTempHome(
      async (dir) => {
        MODEL_CONTEXT_TOKEN_CACHE.set("google/gemini-2.5-pro", 999_000);

        const sessionId = "sess-openrouter-google";
        writeTranscriptUsageLog({
          agentId: "main",
          dir,
          model: "google/gemini-2.5-pro",
          sessionId,
          usage: {
            cacheRead: 1200,
            cacheWrite: 0,
            input: 2,
            output: 3,
            totalTokens: 1205,
          },
        });

        const text = buildStatusMessage({
          agent: {
            model: "openrouter/google/gemini-2.5-pro",
          },
          config: {
            models: {
              providers: {
                google: {
                  models: [{ contextWindow: 2_000_000, id: "gemini-2.5-pro" }],
                },
              },
            },
          } as unknown as OpenClawConfig,
          includeTranscriptUsage: true,
          modelAuth: "api-key",
          queue: { depth: 0, mode: "collect" },
          sessionEntry: {
            sessionId,
            totalTokens: 5,
            updatedAt: 0,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Context: 1.2k/999k");
        expect(normalized).not.toContain("Context: 1.2k/2.0m");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("keeps runtime slash model ids on model-only context lookup when modelProvider is missing", () => {
    MODEL_CONTEXT_TOKEN_CACHE.set("google/gemini-2.5-pro", 999_000);

    const text = buildStatusMessage({
      agent: {
        model: "openrouter/google/gemini-2.5-pro",
      },
      config: {
        models: {
          providers: {
            google: {
              models: [{ contextWindow: 2_000_000, id: "gemini-2.5-pro" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        model: "google/gemini-2.5-pro",
        sessionId: "sess-runtime-slash-id",
        totalTokens: 1205,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 1.2k/999k");
    expect(normalized).not.toContain("Context: 1.2k/2.0m");
  });

  it("keeps provider-aware lookup for legacy fallback runtime slash ids", () => {
    MODEL_CONTEXT_TOKEN_CACHE.clear();

    const text = buildStatusMessage({
      activeModelAuth: "api-key",
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      config: {
        models: {
          providers: {
            "fake-minimax": {
              models: [{ contextWindow: 777_000, id: "FakeMiniMax-M2.5" }],
            },
            xiaomi: {
              models: [{ contextWindow: 1_048_576, id: "mimo-v2-flash" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        fallbackNoticeActiveModel: "fake-minimax/FakeMiniMax-M2.5",
        fallbackNoticeReason: "model not allowed",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        model: "fake-minimax/FakeMiniMax-M2.5",
        modelOverride: "mimo-v2-flash",
        providerOverride: "xiaomi",
        sessionId: "sess-runtime-slash-id-fallback",
        totalTokens: 49_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: fake-minimax/FakeMiniMax-M2.5");
    expect(normalized).toContain("Context: 49k/777k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps provider-aware lookup for non-fallback runtime slash ids", () => {
    MODEL_CONTEXT_TOKEN_CACHE.clear();

    const text = buildStatusMessage({
      activeModelAuth: "api-key",
      agent: {
        model: "openai/gpt-4o",
      },
      config: {
        models: {
          providers: {
            openai: {
              models: [{ contextWindow: 777_000, id: "gpt-4o" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        model: "openai/gpt-4o",
        sessionId: "sess-runtime-slash-id-direct",
        totalTokens: 49_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 49k/777k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps provider-aware lookup for bare transcript model ids", async () => {
    await withTempHome(
      async (dir) => {
        MODEL_CONTEXT_TOKEN_CACHE.set("gemini-2.5-pro", 128_000);
        MODEL_CONTEXT_TOKEN_CACHE.set("google-gemini-cli/gemini-2.5-pro", 1_000_000);

        const sessionId = "sess-google-bare-model";
        writeTranscriptUsageLog({
          agentId: "main",
          dir,
          model: "gemini-2.5-pro",
          sessionId,
          usage: {
            cacheRead: 1200,
            cacheWrite: 0,
            input: 2,
            output: 3,
            totalTokens: 1205,
          },
        });

        const text = buildStatusMessage({
          agent: {
            model: "google-gemini-cli/gemini-2.5-pro",
          },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
          queue: { depth: 0, mode: "collect" },
          sessionEntry: {
            sessionId,
            totalTokens: 5,
            updatedAt: 0,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Context: 1.2k/1.0m");
        expect(normalized).not.toContain("Context: 1.2k/128k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("prefers provider-qualified context windows for fresh bare model ids", () => {
    MODEL_CONTEXT_TOKEN_CACHE.set("claude-opus-4-6", 200_000);
    MODEL_CONTEXT_TOKEN_CACHE.set("anthropic/claude-opus-4-6", 1_000_000);

    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        sessionId: "sess-anthropic-qualified-context",
        totalTokens: 25_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 25k/1.0m");
    expect(normalized).not.toContain("Context: 25k/200k");
  });

  it("does not synthesize a 32k fallback window when the active runtime model is unknown", () => {
    const text = buildStatusMessage({
      activeModelAuth: "api-key",
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      config: {
        models: {
          providers: {
            xiaomi: {
              models: [{ contextWindow: 128_000, id: "mimo-v2-flash" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      modelAuth: "api-key",
      queue: { depth: 0, mode: "collect" },
      sessionEntry: {
        contextTokens: 128_000,
        fallbackNoticeActiveModel: "custom-runtime/unknown-fallback-model",
        fallbackNoticeReason: "model not allowed",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        model: "unknown-fallback-model",
        modelOverride: "mimo-v2-flash",
        modelProvider: "custom-runtime",
        providerOverride: "xiaomi",
        sessionId: "fallback-context-window-unknown-active-model",
        totalTokens: 49_000,
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: custom-runtime/unknown-fallback-model");
    expect(normalized).toContain("Context: 49k/128k");
    expect(normalized).not.toContain("Context: 49k/32k");
  });
});

describe("buildCommandsMessage", () => {
  it("lists commands with aliases and hints", () => {
    const text = buildCommandsMessage({
      commands: { config: false, debug: false },
    } as unknown as OpenClawConfig);
    expect(text).toContain("ℹ️ Slash commands");
    expect(text).toContain("Status");
    expect(text).toContain("/commands - List all slash commands.");
    expect(text).toContain("/skill - Run a skill by name.");
    expect(text).toContain("/think (/thinking, /t) - Set thinking level.");
    expect(text).toContain("/compact - Compact the session context.");
    expect(text).not.toContain("/config");
    expect(text).not.toContain("/debug");
  });

  it("includes skill commands when provided", () => {
    const text = buildCommandsMessage(
      {
        commands: { config: false, debug: false },
      } as unknown as OpenClawConfig,
      [
        {
          description: "Demo skill",
          name: "demo_skill",
          skillName: "demo-skill",
        },
      ],
    );
    expect(text).toContain("/demo_skill - Demo skill");
  });
});

describe("buildHelpMessage", () => {
  it("hides config/debug when disabled", () => {
    const text = buildHelpMessage({
      commands: { config: false, debug: false },
    } as unknown as OpenClawConfig);
    expect(text).toContain("Skills");
    expect(text).toContain("/skill <name> [input]");
    expect(text).not.toContain("/config");
    expect(text).not.toContain("/debug");
  });

  it("includes /fast in help output", () => {
    expect(buildHelpMessage()).toContain("/fast status|on|off");
  });
});

describe("buildCommandsMessagePaginated", () => {
  it("formats telegram output with pages", () => {
    const result = buildCommandsMessagePaginated(
      {
        commands: { config: false, debug: false },
      } as unknown as OpenClawConfig,
      undefined,
      { forcePaginatedList: true, page: 1, surface: "telegram" },
    );
    expect(result.text).toContain("ℹ️ Commands (1/");
    expect(result.text).toContain("Session");
    expect(result.text).toContain("/stop - Stop the current run.");
  });

  it("includes plugin commands in the paginated list", async () => {
    const pluginCommands = [
      { description: "Plugin command", name: "plugin_cmd", pluginId: "demo-plugin" },
    ];
    listPluginCommands.mockImplementation(() => pluginCommands);
    expect(listPluginCommands()).toEqual(pluginCommands);
    vi.resetModules();
    const { buildCommandsMessagePaginated: buildPaginatedCommands } = await import("./status.js");
    const firstPage = buildPaginatedCommands(
      {
        commands: { config: false, debug: false },
      } as unknown as OpenClawConfig,
      undefined,
      { forcePaginatedList: true, page: 1, surface: "telegram" },
    );
    const pages = Array.from({ length: firstPage.totalPages }, (_, index) =>
      buildPaginatedCommands(
        {
          commands: { config: false, debug: false },
        } as unknown as OpenClawConfig,
        undefined,
        { forcePaginatedList: true, page: index + 1, surface: "telegram" },
      ),
    );
    const pluginPage = pages.find((page) => page.text.includes("/plugin_cmd (demo-plugin)"));
    expect(pluginPage).toBeTruthy();
    expect(pluginPage?.text).toContain("Plugins");
    expect(pluginPage?.text).toContain("/plugin_cmd (demo-plugin) - Plugin command");
  });
});
