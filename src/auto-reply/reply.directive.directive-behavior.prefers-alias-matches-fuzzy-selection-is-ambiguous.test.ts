import "./reply.directive.directive-behavior.e2e-mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  MAIN_SESSION_KEY,
  assertModelSelection,
  installDirectiveBehaviorE2EHooks,
  makeWhatsAppDirectiveConfig,
  replyText,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { runEmbeddedPiAgentMock } from "./reply.directive.directive-behavior.e2e-mocks.js";
import { getReplyFromConfig } from "./reply.js";
import { withFullRuntimeReplyConfig } from "./reply/get-reply-fast-path.js";

function makeModelDefinition(id: string, name: string): ModelDefinitionConfig {
  return {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text"],
    maxTokens: 8192,
    name,
    reasoning: false,
  };
}

function makeModelSwitchConfig(home: string) {
  return makeWhatsAppDirectiveConfig(home, {
    model: { primary: "openai/gpt-4.1-mini" },
    models: {
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "openai/gpt-4.1-mini": {},
    },
  });
}

function makeMoonshotConfig(home: string, storePath: string) {
  return withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: {
          "anthropic/claude-opus-4-6": {},
          "moonshot/kimi-k2-0905-preview": {},
        },
        workspace: path.join(home, "openclaw"),
      },
    },
    models: {
      mode: "merge",
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.ai/v1",
          apiKey: "sk-test", // Pragma: allowlist secret
          api: "openai-completions",
          models: [makeModelDefinition("kimi-k2-0905-preview", "Kimi K2")],
        },
      },
    },
    session: { store: storePath },
  } as unknown as OpenClawConfig);
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  async function runMoonshotModelDirective(params: {
    home: string;
    storePath: string;
    body: string;
  }) {
    return await getReplyFromConfig(
      { Body: params.body, CommandAuthorized: true, From: "+1222", To: "+1222" },
      {},
      makeMoonshotConfig(params.home, params.storePath),
    );
  }

  function expectMoonshotSelectionFromResponse(params: {
    response: Awaited<ReturnType<typeof getReplyFromConfig>>;
    storePath: string;
  }) {
    const text = Array.isArray(params.response) ? params.response[0]?.text : params.response?.text;
    expect(text).toContain("Model set to moonshot/kimi-k2-0905-preview.");
    assertModelSelection(params.storePath, {
      model: "kimi-k2-0905-preview",
      provider: "moonshot",
    });
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  }

  it("supports unambiguous fuzzy model matches across /model forms", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      for (const body of ["/model kimi", "/model kimi-k2-0905-preview", "/model moonshot/kimi"]) {
        const res = await runMoonshotModelDirective({
          body,
          home,
          storePath,
        });
        expectMoonshotSelectionFromResponse({ response: res, storePath });
      }
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("picks the best fuzzy match for global and provider-scoped minimax queries", async () => {
    await withTempHome(async (home) => {
      for (const testCase of [
        {
          body: "/model minimax",
          config: {
            agents: {
              defaults: {
                model: { primary: "minimax/MiniMax-M2.7" },
                models: {
                  "lmstudio/minimax-m2.5-gs32": {},
                  "minimax/MiniMax-M2.7": {},
                  "minimax/MiniMax-M2.7-highspeed": {},
                },
                workspace: path.join(home, "openclaw"),
              },
            },
            models: {
              mode: "merge",
              providers: {
                lmstudio: {
                  baseUrl: "http://127.0.0.1:1234/v1",
                  apiKey: "lmstudio", // Pragma: allowlist secret
                  api: "openai-responses",
                  models: [makeModelDefinition("minimax-m2.5-gs32", "MiniMax M2.5 GS32")],
                },
                minimax: {
                  baseUrl: "https://api.minimax.io/anthropic",
                  apiKey: "sk-test", // Pragma: allowlist secret
                  api: "anthropic-messages",
                  models: [
                    makeModelDefinition("MiniMax-M2.7", "MiniMax M2.7"),
                    makeModelDefinition("MiniMax-M2.7-highspeed", "MiniMax M2.7 Highspeed"),
                  ],
                },
              },
            },
          },
          expectedSelection: {},
          storePath: path.join(home, "sessions-global-fuzzy.json"),
        },
        {
          body: "/model minimax/highspeed",
          config: {
            agents: {
              defaults: {
                model: { primary: "minimax/MiniMax-M2.7" },
                models: {
                  "minimax/MiniMax-M2.7": {},
                  "minimax/MiniMax-M2.7-highspeed": {},
                },
                workspace: path.join(home, "openclaw"),
              },
            },
            models: {
              mode: "merge",
              providers: {
                minimax: {
                  baseUrl: "https://api.minimax.io/anthropic",
                  apiKey: "sk-test", // Pragma: allowlist secret
                  api: "anthropic-messages",
                  models: [
                    makeModelDefinition("MiniMax-M2.7", "MiniMax M2.7"),
                    makeModelDefinition("MiniMax-M2.7-highspeed", "MiniMax M2.7 Highspeed"),
                  ],
                },
              },
            },
          },
          expectedSelection: {
            model: "MiniMax-M2.7-highspeed",
            provider: "minimax",
          },
          storePath: path.join(home, "sessions-provider-fuzzy.json"),
        },
      ]) {
        await getReplyFromConfig(
          { Body: testCase.body, CommandAuthorized: true, From: "+1222", To: "+1222" },
          {},
          withFullRuntimeReplyConfig({
            ...testCase.config,
            session: { store: testCase.storePath },
          } as unknown as OpenClawConfig),
        );
        assertModelSelection(testCase.storePath, testCase.expectedSelection);
      }
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("prefers alias matches when fuzzy selection is ambiguous", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);

      const res = await getReplyFromConfig(
        { Body: "/model ki", CommandAuthorized: true, From: "+1222", To: "+1222" },
        {},
        withFullRuntimeReplyConfig({
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-6" },
              models: {
                "anthropic/claude-opus-4-6": {},
                "lmstudio/kimi-k2-0905-preview": {},
                "moonshot/kimi-k2-0905-preview": { alias: "Kimi" },
              },
              workspace: path.join(home, "openclaw"),
            },
          },
          models: {
            mode: "merge",
            providers: {
              lmstudio: {
                baseUrl: "http://127.0.0.1:1234/v1",
                apiKey: "lmstudio", // Pragma: allowlist secret
                api: "openai-responses",
                models: [makeModelDefinition("kimi-k2-0905-preview", "Kimi K2 (Local)")],
              },
              moonshot: {
                baseUrl: "https://api.moonshot.ai/v1",
                apiKey: "sk-test", // Pragma: allowlist secret
                api: "openai-completions",
                models: [makeModelDefinition("kimi-k2-0905-preview", "Kimi K2")],
              },
            },
          },
          session: { store: storePath },
        } as OpenClawConfig),
      );

      const text = replyText(res);
      expect(text).toContain("Model set to Kimi (moonshot/kimi-k2-0905-preview).");
      assertModelSelection(storePath, {
        model: "kimi-k2-0905-preview",
        provider: "moonshot",
      });
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("stores auth profile overrides on /model directive", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);
      const authDir = path.join(home, ".openclaw", "agents", "main", "agent");
      await fs.mkdir(authDir, { mode: 0o700, recursive: true });
      await fs.writeFile(
        path.join(authDir, "auth-profiles.json"),
        JSON.stringify(
          {
            profiles: {
              "anthropic:work": {
                key: "sk-test-1234567890",
                provider: "anthropic",
                type: "api_key",
              },
            },
            version: 1,
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        { Body: "/model Opus@anthropic:work", CommandAuthorized: true, From: "+1222", To: "+1222" },
        {},
        makeModelSwitchConfig(home),
      );

      const text = replyText(res);
      expect(text).toContain("Auth profile set to anthropic:work");
      const store = loadSessionStore(storePath);
      const entry = store["agent:main:main"];
      expect(entry.authProfileOverride).toBe("anthropic:work");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("queues system events for model, elevated, and reasoning directives", async () => {
    await withTempHome(async (home) => {
      drainSystemEvents(MAIN_SESSION_KEY);
      await getReplyFromConfig(
        { Body: "/model Opus", CommandAuthorized: true, From: "+1222", To: "+1222" },
        {},
        makeModelSwitchConfig(home),
      );

      let events = drainSystemEvents(MAIN_SESSION_KEY);
      expect(events).toContain("Model switched to Opus (anthropic/claude-opus-4-6).");

      drainSystemEvents(MAIN_SESSION_KEY);

      await getReplyFromConfig(
        {
          Body: "/elevated on",
          CommandAuthorized: true,
          From: "+1222",
          Provider: "whatsapp",
          To: "+1222",
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          { model: { primary: "openai/gpt-4.1-mini" } },
          { tools: { elevated: { allowFrom: { whatsapp: ["*"] } } } },
        ),
      );

      events = drainSystemEvents(MAIN_SESSION_KEY);
      expect(events.some((e) => e.includes("Elevated ASK"))).toBe(true);

      drainSystemEvents(MAIN_SESSION_KEY);

      await getReplyFromConfig(
        {
          Body: "/reasoning stream",
          CommandAuthorized: true,
          From: "+1222",
          Provider: "whatsapp",
          To: "+1222",
        },
        {},
        makeWhatsAppDirectiveConfig(home, { model: { primary: "openai/gpt-4.1-mini" } }),
      );

      events = drainSystemEvents(MAIN_SESSION_KEY);
      expect(events.some((e) => e.includes("Reasoning STREAM"))).toBe(true);
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
});
