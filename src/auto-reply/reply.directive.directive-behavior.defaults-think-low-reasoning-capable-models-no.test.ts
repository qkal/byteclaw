import "./reply.directive.directive-behavior.e2e-mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import {
  DEFAULT_TEST_MODEL_CATALOG,
  assertModelSelection,
  installDirectiveBehaviorE2EHooks,
  installFreshDirectiveBehaviorReplyMocks,
  makeEmbeddedTextResult,
  makeWhatsAppDirectiveConfig,
  mockEmbeddedTextResult,
  replyText,
  replyTexts,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import {
  loadModelCatalogMock,
  runEmbeddedPiAgentMock,
} from "./reply.directive.directive-behavior.e2e-mocks.js";
import { runModelDirectiveText } from "./reply.directive.directive-behavior.model-directive-test-utils.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;

function makeDefaultModelConfig(home: string) {
  return makeWhatsAppDirectiveConfig(home, {
    model: { primary: "anthropic/claude-opus-4-6" },
    models: {
      "anthropic/claude-opus-4-6": {},
      "openai/gpt-4.1-mini": {},
    },
  });
}

async function runReplyToCurrentCase(home: string, text: string) {
  runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult(text));

  const res = await getReplyFromConfig(
    {
      Body: "ping",
      From: "+1004",
      MessageSid: "msg-123",
      To: "+2000",
    },
    {},
    makeWhatsAppDirectiveConfig(home, { model: "anthropic/claude-opus-4-6" }),
  );

  return Array.isArray(res) ? res[0] : res;
}

async function expectThinkStatusForReasoningModel(params: {
  home: string;
  reasoning: boolean;
  expectedLevel: "low" | "off";
}): Promise<void> {
  loadModelCatalogMock.mockResolvedValueOnce([
    {
      id: "claude-opus-4-6",
      name: "Opus 4.5",
      provider: "anthropic",
      reasoning: params.reasoning,
    },
  ]);

  const res = await getReplyFromConfig(
    { Body: "/think", CommandAuthorized: true, From: "+1222", To: "+1222" },
    {},
    makeWhatsAppDirectiveConfig(params.home, { model: "anthropic/claude-opus-4-6" }),
  );

  const text = replyText(res);
  expect(text).toContain(`Current thinking level: ${params.expectedLevel}`);
  expect(text).toContain("Options: off, minimal, low, medium, high, adaptive.");
}

function mockReasoningCapableCatalog() {
  loadModelCatalogMock.mockResolvedValueOnce([
    {
      id: "claude-opus-4-6",
      name: "Opus 4.5",
      provider: "anthropic",
      reasoning: true,
    },
  ]);
}

async function runReasoningDefaultCase(params: {
  home: string;
  expectedThinkLevel: "low" | "off";
  expectedReasoningLevel: "off" | "on";
  thinkingDefault?: "off" | "low" | "medium" | "high";
}) {
  runEmbeddedPiAgentMock.mockClear();
  mockEmbeddedTextResult("done");
  mockReasoningCapableCatalog();

  await getReplyFromConfig(
    {
      Body: "hello",
      From: "+1004",
      To: "+2000",
    },
    {},
    makeWhatsAppDirectiveConfig(params.home, {
      model: { primary: "anthropic/claude-opus-4-6" },
      ...(params.thinkingDefault ? { thinkingDefault: params.thinkingDefault } : {}),
    }),
  );

  expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
  const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
  expect(call?.thinkLevel).toBe(params.expectedThinkLevel);
  expect(call?.reasoningLevel).toBe(params.expectedReasoningLevel);
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  beforeEach(async () => {
    vi.resetModules();
    loadModelCatalogMock.mockReset();
    loadModelCatalogMock.mockResolvedValue(DEFAULT_TEST_MODEL_CATALOG);
    installFreshDirectiveBehaviorReplyMocks();
    ({ getReplyFromConfig } = await import("./reply.js"));
  });

  it("covers /think status and reasoning defaults for reasoning and non-reasoning models", async () => {
    await withTempHome(async (home) => {
      await expectThinkStatusForReasoningModel({
        expectedLevel: "low",
        home,
        reasoning: true,
      });
      await expectThinkStatusForReasoningModel({
        expectedLevel: "off",
        home,
        reasoning: false,
      });
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();

      runEmbeddedPiAgentMock.mockClear();

      for (const scenario of [
        {
          expectedReasoningLevel: "off" as const,
          expectedThinkLevel: "low" as const,
        },
        {
          expectedReasoningLevel: "on" as const,
          expectedThinkLevel: "off" as const,
          thinkingDefault: "off" as const,
        },
      ]) {
        await runReasoningDefaultCase({
          home,
          ...scenario,
        });
      }
    });
  });
  it("renders model list and status variants across catalog/config combinations", async () => {
    await withTempHome(async (home) => {
      const aliasText = await runModelDirectiveText(home, "/model list");
      expect(aliasText).toContain("Providers:");
      expect(aliasText).toContain("- anthropic");
      expect(aliasText).toContain("- openai");
      expect(aliasText).toContain("Use: /models <provider>");
      expect(aliasText).toContain("Switch: /model <provider/model>");

      loadModelCatalogMock.mockResolvedValueOnce([]);
      const unavailableCatalogText = await runModelDirectiveText(home, "/model");
      expect(unavailableCatalogText).toContain("Current: anthropic/claude-opus-4-6");
      expect(unavailableCatalogText).toContain("Switch: /model <provider/model>");
      expect(unavailableCatalogText).toContain(
        "Browse: /models (providers) or /models <provider> (models)",
      );
      expect(unavailableCatalogText).toContain("More: /model status");

      const allowlistedStatusText = await runModelDirectiveText(home, "/model status", {
        includeSessionStore: false,
      });
      expect(allowlistedStatusText).toContain("anthropic/claude-opus-4-6");
      expect(allowlistedStatusText).toContain("openai/gpt-4.1-mini");
      expect(allowlistedStatusText).not.toContain("claude-sonnet-4-1");
      expect(allowlistedStatusText).toContain("auth:");

      loadModelCatalogMock.mockResolvedValue([
        { id: "claude-opus-4-6", name: "Opus 4.5", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "grok-4", name: "Grok 4", provider: "xai" },
      ]);
      const noAllowlistText = await runModelDirectiveText(home, "/model list", {
        defaults: {
          imageModel: { primary: "minimax/MiniMax-M2.7" },
          model: {
            fallbacks: ["openai/gpt-4.1-mini"],
            primary: "anthropic/claude-opus-4-6",
          },
          models: undefined,
        },
      });
      expect(noAllowlistText).toContain("Providers:");
      expect(noAllowlistText).toContain("- anthropic");
      expect(noAllowlistText).toContain("- openai");
      expect(noAllowlistText).toContain("- xai");
      expect(noAllowlistText).toContain("Use: /models <provider>");

      loadModelCatalogMock.mockResolvedValueOnce([
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.5",
          provider: "anthropic",
        },
        { id: "gpt-4.1-mini", name: "GPT-4.1 mini", provider: "openai" },
      ]);
      const configOnlyProviderText = await runModelDirectiveText(home, "/models minimax", {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {},
            "minimax/MiniMax-M2.7": { alias: "minimax" },
            "openai/gpt-4.1-mini": {},
          },
        },
        extra: {
          models: {
            mode: "merge",
            providers: {
              minimax: {
                api: "anthropic-messages",
                baseUrl: "https://api.minimax.io/anthropic",
                models: [
                  { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
                  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" },
                ],
              },
            },
          },
        },
      });
      expect(configOnlyProviderText).toContain("Models (minimax");
      expect(configOnlyProviderText).toContain("minimax/MiniMax-M2.7");

      const missingAuthText = await runModelDirectiveText(home, "/model list", {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        },
      });
      expect(missingAuthText).toContain("Providers:");
      expect(missingAuthText).not.toContain("missing (missing)");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("sets model override on /model directive", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);

      await getReplyFromConfig(
        { Body: "/model openai/gpt-4.1-mini", CommandAuthorized: true, From: "+1222", To: "+1222" },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-4.1-mini": {},
            },
          },
          { session: { store: storePath } },
        ),
      );

      assertModelSelection(storePath, {
        model: "gpt-4.1-mini",
        provider: "openai",
      });
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("ignores inline /model and /think directives while still running agent content", async () => {
    await withTempHome(async (home) => {
      mockEmbeddedTextResult("done");

      const inlineModelRes = await getReplyFromConfig(
        {
          Body: "please sync /model openai/gpt-4.1-mini now",
          From: "+1004",
          To: "+2000",
        },
        {},
        makeDefaultModelConfig(home),
      );

      const texts = replyTexts(inlineModelRes);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-opus-4-6");
      runEmbeddedPiAgentMock.mockClear();

      mockEmbeddedTextResult("done");
      const inlineThinkRes = await getReplyFromConfig(
        {
          Body: "please sync /think:high now",
          From: "+1004",
          To: "+2000",
        },
        {},
        makeWhatsAppDirectiveConfig(home, { model: { primary: "anthropic/claude-opus-4-6" } }),
      );

      expect(replyTexts(inlineThinkRes)).toContain("done");
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    });
  });
  it("passes elevated defaults when sender is approved", async () => {
    await withTempHome(async (home) => {
      mockEmbeddedTextResult("done");

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1004",
          Provider: "whatsapp",
          SenderE164: "+1004",
          To: "+2000",
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          { model: { primary: "anthropic/claude-opus-4-6" } },
          {
            tools: {
              elevated: {
                allowFrom: { whatsapp: ["+1004"] },
              },
            },
          },
        ),
      );

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.bashElevated).toEqual({
        allowed: true,
        defaultLevel: "on",
        enabled: true,
      });
    });
  });
  it("persists /reasoning off on discord even when model defaults reasoning on", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);
      mockEmbeddedTextResult("done");
      loadModelCatalogMock.mockResolvedValue([
        {
          id: "x-ai/grok-4.1-fast",
          name: "Grok 4.1 Fast",
          provider: "openrouter",
          reasoning: true,
        },
      ]);

      const config = makeWhatsAppDirectiveConfig(
        home,
        {
          model: "openrouter/x-ai/grok-4.1-fast",
        },
        {
          channels: {
            discord: { allowFrom: ["*"] },
          },
          session: { store: storePath },
        },
      );

      const offRes = await getReplyFromConfig(
        {
          Body: "/reasoning off",
          CommandAuthorized: true,
          CommandSource: "text",
          From: "discord:user:1004",
          Provider: "discord",
          Surface: "discord",
          To: "channel:general",
        },
        {},
        config,
      );
      expect(replyText(offRes)).toContain("Reasoning visibility disabled.");

      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.reasoningLevel).toBe("off");

      await getReplyFromConfig(
        {
          Body: "hello",
          CommandAuthorized: true,
          CommandSource: "text",
          From: "discord:user:1004",
          Provider: "discord",
          Surface: "discord",
          To: "channel:general",
        },
        {},
        config,
      );

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.reasoningLevel).toBe("off");
    });
  });
  it("handles reply_to_current tags and explicit reply_to precedence", async () => {
    await withTempHome(async (home) => {
      for (const replyTag of ["[[reply_to_current]]", "[[ reply_to_current ]]"]) {
        const payload = await runReplyToCurrentCase(home, `hello ${replyTag}`);
        expect(payload?.text).toBe("hello");
        expect(payload?.replyToId).toBe("msg-123");
      }

      runEmbeddedPiAgentMock.mockResolvedValue(
        makeEmbeddedTextResult("hi [[reply_to_current]] [[reply_to:abc-456]]"),
      );

      const res = await getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          MessageSid: "msg-123",
          To: "+2000",
        },
        {},
        makeWhatsAppDirectiveConfig(home, { model: { primary: "anthropic/claude-opus-4-6" } }),
      );

      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload?.text).toBe("hi");
      expect(payload?.replyToId).toBe("abc-456");
    });
  });
});
