/**
 * Layer 1: Hook Merger Tests for before_agent_start
 *
 * Validates that modelOverride and providerOverride fields are correctly
 * propagated through the hook merger, including priority ordering and
 * backward compatibility.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { TEST_PLUGIN_AGENT_CTX, addStaticTestHooks, addTestHook } from "./hooks.test-helpers.js";
import { type PluginRegistry, createEmptyPluginRegistry } from "./registry.js";
import type { PluginHookBeforeAgentStartResult, PluginHookRegistration } from "./types.js";

function addBeforeAgentStartHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: () => PluginHookBeforeAgentStartResult | Promise<PluginHookBeforeAgentStartResult>,
  priority?: number,
) {
  addTestHook({
    handler: handler as PluginHookRegistration["handler"],
    hookName: "before_agent_start",
    pluginId,
    priority,
    registry,
  });
}

const stubCtx = TEST_PLUGIN_AGENT_CTX;

describe("before_agent_start hook merger", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  const runWithSingleHook = async (result: PluginHookBeforeAgentStartResult, priority?: number) => {
    addBeforeAgentStartHook(registry, "plugin-a", () => result, priority);
    const runner = createHookRunner(registry);
    return await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);
  };

  const expectSingleModelOverride = async (modelOverride: string) => {
    const result = await runWithSingleHook({ modelOverride });
    expect(result?.modelOverride).toBe(modelOverride);
    return result;
  };

  const expectMergedBeforeAgentStart = async (
    hooks: {
      pluginId: string;
      result: PluginHookBeforeAgentStartResult;
      priority?: number;
    }[],
    expected: Partial<PluginHookBeforeAgentStartResult>,
  ) => {
    const result = await runWithHooks(hooks);
    expect(result).toEqual(expect.objectContaining(expected));
    return result;
  };

  const runWithHooks = async (
    hooks: {
      pluginId: string;
      result: PluginHookBeforeAgentStartResult;
      priority?: number;
    }[],
  ) => {
    addStaticTestHooks(registry, {
      hookName: "before_agent_start",
      hooks,
    });
    const runner = createHookRunner(registry);
    return await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);
  };

  it.each([
    [
      "returns modelOverride from a single plugin",
      { modelOverride: "llama3.3:8b" },
      {
        modelOverride: "llama3.3:8b",
      },
    ],
    [
      "returns providerOverride from a single plugin",
      { providerOverride: "ollama" },
      {
        providerOverride: "ollama",
      },
    ],
    [
      "returns both modelOverride and providerOverride together",
      {
        modelOverride: "llama3.3:8b",
        providerOverride: "ollama",
      },
      {
        modelOverride: "llama3.3:8b",
        providerOverride: "ollama",
      },
    ],
    [
      "systemPrompt merges correctly alongside model overrides",
      {
        modelOverride: "llama3.3:8b",
        providerOverride: "ollama",
        systemPrompt: "You are a helpful assistant",
      },
      {
        modelOverride: "llama3.3:8b",
        providerOverride: "ollama",
        systemPrompt: "You are a helpful assistant",
      },
    ],
  ] as const)("%s", async (_name, hookResult, expected) => {
    await expectMergedBeforeAgentStart([{ pluginId: "plugin-a", result: hookResult }], expected);
  });

  it("higher-priority plugin wins for modelOverride", async () => {
    const result = await expectMergedBeforeAgentStart(
      [
        { pluginId: "low-priority", priority: 1, result: { modelOverride: "gpt-5.4" } },
        { pluginId: "high-priority", priority: 10, result: { modelOverride: "llama3.3:8b" } },
      ],
      { modelOverride: "llama3.3:8b" },
    );
    expect(result?.modelOverride).toBe("llama3.3:8b");
  });

  it("lower-priority plugin does not overwrite if it returns undefined", async () => {
    const result = await runWithHooks([
      {
        pluginId: "high-priority",
        priority: 10,
        result: { modelOverride: "llama3.3:8b", providerOverride: "ollama" },
      },
      {
        pluginId: "low-priority",
        priority: 1,
        result: { prependContext: "some context" },
      },
    ]);

    // High-priority ran first (priority 10), low-priority ran second (priority 1).
    // Low-priority didn't return modelOverride, so ?? falls back to acc's value.
    expect(result?.modelOverride).toBe("llama3.3:8b");
    expect(result?.providerOverride).toBe("ollama");
    expect(result?.prependContext).toBe("some context");
  });

  it("prependContext still concatenates when modelOverride is present", async () => {
    const result = await runWithHooks([
      {
        pluginId: "plugin-a",
        priority: 10,
        result: { modelOverride: "llama3.3:8b", prependContext: "context A" },
      },
      {
        pluginId: "plugin-b",
        priority: 1,
        result: { prependContext: "context B" },
      },
    ]);

    expect(result?.prependContext).toBe("context A\n\ncontext B");
    expect(result?.modelOverride).toBe("llama3.3:8b");
  });

  it("backward compat: plugin returning only prependContext produces no modelOverride", async () => {
    const result = await runWithSingleHook({ prependContext: "legacy context" });

    expect(result?.prependContext).toBe("legacy context");
    expect(result?.modelOverride).toBeUndefined();
    expect(result?.providerOverride).toBeUndefined();
  });

  it("modelOverride without providerOverride leaves provider undefined", async () => {
    const result = await expectSingleModelOverride("llama3.3:8b");
    expect(result?.providerOverride).toBeUndefined();
  });

  it("returns undefined when no hooks are registered", async () => {
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    expect(result).toBeUndefined();
  });

  it("passes runId through the agent context to hook handlers", async () => {
    const registry = createEmptyPluginRegistry();
    let capturedCtx: typeof stubCtx | undefined;
    addTestHook({
      handler: ((_event: unknown, ctx: typeof stubCtx) => {
        capturedCtx = ctx;
        return {};
      }) as PluginHookRegistration["handler"],
      hookName: "before_agent_start",
      pluginId: "ctx-spy",
      registry,
    });

    const runner = createHookRunner(registry);
    await runner.runBeforeAgentStart({ prompt: "test" }, stubCtx);

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.runId).toBe("test-run-id");
  });
});
