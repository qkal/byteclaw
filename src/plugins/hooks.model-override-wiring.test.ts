/**
 * Layer 2: Explicit model/prompt hook wiring tests.
 *
 * Verifies:
 * 1. before_model_resolve applies deterministic provider/model overrides
 * 2. before_prompt_build receives session messages and prepends prompt context
 * 3. before_agent_start remains a legacy compatibility fallback
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { joinPresentTextSegments } from "../shared/text/join-segments.js";
import { createHookRunner } from "./hooks.js";
import { TEST_PLUGIN_AGENT_CTX, addTestHook } from "./hooks.test-helpers.js";
import { type PluginRegistry, createEmptyPluginRegistry } from "./registry.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
} from "./types.js";

function addBeforeModelResolveHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (
    event: PluginHookBeforeModelResolveEvent,
    ctx: PluginHookAgentContext,
  ) => PluginHookBeforeModelResolveResult | Promise<PluginHookBeforeModelResolveResult>,
  priority?: number,
) {
  addTestHook({
    handler: handler as PluginHookRegistration["handler"],
    hookName: "before_model_resolve",
    pluginId,
    priority,
    registry,
  });
}

function addBeforePromptBuildHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ) => PluginHookBeforePromptBuildResult | Promise<PluginHookBeforePromptBuildResult>,
  priority?: number,
) {
  addTestHook({
    handler: handler as PluginHookRegistration["handler"],
    hookName: "before_prompt_build",
    pluginId,
    priority,
    registry,
  });
}

const stubCtx: PluginHookAgentContext = TEST_PLUGIN_AGENT_CTX;

describe("model override pipeline wiring", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  function addLegacyBeforeAgentStartHook(
    result: PluginHookBeforeModelResolveResult | PluginHookBeforePromptBuildResult,
  ) {
    addTestHook({
      handler: (() => result) as PluginHookRegistration["handler"],
      hookName: "before_agent_start",
      pluginId: "legacy-hook",
      registry,
    });
  }

  async function runPromptBuildWithMessages(messages: unknown[]) {
    const runner = createHookRunner(registry);
    return await runner.runBeforePromptBuild({ messages, prompt: "test" }, stubCtx);
  }

  async function expectBeforeModelResolve(params: {
    event: PluginHookBeforeModelResolveEvent;
    expected: Partial<PluginHookBeforeModelResolveResult>;
    withBrokenHook?: boolean;
    catchErrors?: boolean;
  }) {
    const handlerSpy = vi.fn(
      (_event: PluginHookBeforeModelResolveEvent) =>
        ({
          modelOverride: "demo-local-model",
          providerOverride: "demo-local-provider",
        }) as PluginHookBeforeModelResolveResult,
    );

    if (params.withBrokenHook) {
      addBeforeModelResolveHook(
        registry,
        "broken-plugin",
        () => {
          throw new Error("plugin crashed");
        },
        10,
      );
    }
    addBeforeModelResolveHook(registry, "router-plugin", handlerSpy);
    const runner = createHookRunner(
      registry,
      params.catchErrors ? { catchErrors: true } : undefined,
    );
    const result = await runner.runBeforeModelResolve(params.event, stubCtx);

    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(handlerSpy).toHaveBeenCalledWith(params.event, stubCtx);
    expect(result).toEqual(expect.objectContaining(params.expected));
    return result;
  }

  async function expectPromptBuildPrependContext(params: {
    messages: unknown[];
    expectedPrependContext: string;
    legacyPrependContext?: string;
  }) {
    const handlerSpy = vi.fn(
      (event: PluginHookBeforePromptBuildEvent) =>
        ({
          prependContext: params.legacyPrependContext
            ? "new context"
            : `Saw ${event.messages.length} messages`,
        }) as PluginHookBeforePromptBuildResult,
    );

    addBeforePromptBuildHook(registry, "context-plugin", handlerSpy);
    if (params.legacyPrependContext) {
      addLegacyBeforeAgentStartHook({
        prependContext: params.legacyPrependContext,
      });
    }
    const result = await runPromptBuildWithMessages(params.messages);

    expect(handlerSpy).toHaveBeenCalledTimes(1);
    if (!params.legacyPrependContext) {
      expect(result?.prependContext).toBe(params.expectedPrependContext);
      return result;
    }

    const runner = createHookRunner(registry);
    const legacy = await runner.runBeforeAgentStart(
      { messages: params.messages, prompt: "test" },
      stubCtx,
    );
    const prependContext = joinPresentTextSegments([
      result?.prependContext,
      legacy?.prependContext,
    ]);
    expect(prependContext).toBe(params.expectedPrependContext);
    return result;
  }

  describe("before_model_resolve (run.ts pattern)", () => {
    it.each([
      {
        event: { prompt: "PII text" },
        expected: {
          modelOverride: "demo-local-model",
          providerOverride: "demo-local-provider",
        },
        name: "hook receives prompt-only event and returns provider/model override",
      },
      {
        catchErrors: true,
        event: { prompt: "PII data" },
        expected: {
          modelOverride: "demo-local-model",
          providerOverride: "demo-local-provider",
        },
        name: "one broken before_model_resolve plugin does not block other overrides",
        withBrokenHook: true,
      },
    ] as const)("$name", async ({ event, expected, withBrokenHook, catchErrors }) => {
      await expectBeforeModelResolve({ catchErrors, event, expected, withBrokenHook });
    });

    it("new hook overrides beat legacy before_agent_start fallback", async () => {
      addBeforeModelResolveHook(registry, "new-hook", () => ({
        modelOverride: "demo-local-model",
        providerOverride: "demo-local-provider",
      }));
      addLegacyBeforeAgentStartHook({
        modelOverride: "demo-legacy-model",
        providerOverride: "demo-legacy-provider",
      });

      const runner = createHookRunner(registry);
      const explicit = await runner.runBeforeModelResolve({ prompt: "sensitive" }, stubCtx);
      const legacy = await runner.runBeforeAgentStart({ prompt: "sensitive" }, stubCtx);
      const merged = {
        modelOverride: explicit?.modelOverride ?? legacy?.modelOverride,
        providerOverride: explicit?.providerOverride ?? legacy?.providerOverride,
      };

      expect(merged.providerOverride).toBe("demo-local-provider");
      expect(merged.modelOverride).toBe("demo-local-model");
    });
  });

  describe("before_prompt_build (attempt.ts pattern)", () => {
    it.each([
      {
        expectedPrependContext: "Saw 2 messages",
        messages: [{}, {}] as unknown[],
        name: "hook receives prompt and messages and can prepend context",
      },
      {
        expectedPrependContext: "new context\n\nlegacy context",
        legacyPrependContext: "legacy context",
        messages: [{ content: "x", role: "user" }] as unknown[],
        name: "legacy before_agent_start context can still be merged as fallback",
      },
    ] as const)("$name", async ({ messages, legacyPrependContext, expectedPrependContext }) => {
      await expectPromptBuildPrependContext({
        expectedPrependContext,
        legacyPrependContext,
        messages,
      });
    });
  });

  describe("graceful degradation + hook detection", () => {
    it("hasHooks reports new and legacy hooks independently", () => {
      const runner1 = createHookRunner(registry);
      expect(runner1.hasHooks("before_model_resolve")).toBe(false);
      expect(runner1.hasHooks("before_prompt_build")).toBe(false);
      expect(runner1.hasHooks("before_agent_start")).toBe(false);

      addBeforeModelResolveHook(registry, "plugin-a", () => ({}));
      addBeforePromptBuildHook(registry, "plugin-b", () => ({}));
      addTestHook({
        handler: (() => ({})) as PluginHookRegistration["handler"],
        hookName: "before_agent_start",
        pluginId: "plugin-c",
        registry,
      });

      const runner2 = createHookRunner(registry);
      expect(runner2.hasHooks("before_model_resolve")).toBe(true);
      expect(runner2.hasHooks("before_prompt_build")).toBe(true);
      expect(runner2.hasHooks("before_agent_start")).toBe(true);
    });
  });
});
