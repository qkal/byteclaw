import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks } from "./hooks.test-helpers.js";
import { type PluginRegistry, createEmptyPluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "./types.js";

describe("phase hooks merger", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  async function runPhaseHook(params: {
    hookName: "before_model_resolve" | "before_prompt_build";
    hooks: readonly {
      pluginId: string;
      result: PluginHookBeforeModelResolveResult | PluginHookBeforePromptBuildResult;
      priority?: number;
    }[];
  }) {
    addStaticTestHooks(registry, {
      hookName: params.hookName,
      hooks: [...params.hooks],
    });
    const runner = createHookRunner(registry);
    if (params.hookName === "before_model_resolve") {
      return await runner.runBeforeModelResolve({ prompt: "test" }, {});
    }
    return await runner.runBeforePromptBuild({ messages: [], prompt: "test" }, {});
  }

  async function expectPhaseHookMerge(params: {
    hookName: "before_model_resolve" | "before_prompt_build";
    hooks: readonly {
      pluginId: string;
      result: PluginHookBeforeModelResolveResult | PluginHookBeforePromptBuildResult;
      priority?: number;
    }[];
    expected: Record<string, unknown>;
  }) {
    const result = await runPhaseHook(params);
    expect(result).toEqual(expect.objectContaining(params.expected));
  }

  it.each([
    {
      expected: {
        modelOverride: "demo-high-priority-model",
        providerOverride: "demo-provider",
      },
      hookName: "before_model_resolve" as const,
      hooks: [
        { pluginId: "low", priority: 1, result: { modelOverride: "demo-low-priority-model" } },
        {
          pluginId: "high",
          priority: 10,
          result: {
            modelOverride: "demo-high-priority-model",
            providerOverride: "demo-provider",
          },
        },
      ],
      name: "before_model_resolve keeps higher-priority override values",
    },
    {
      expected: {
        prependContext: "context A\n\ncontext B",
        systemPrompt: "system A",
      },
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "high",
          priority: 10,
          result: { prependContext: "context A", systemPrompt: "system A" },
        },
        {
          pluginId: "low",
          priority: 1,
          result: { prependContext: "context B", systemPrompt: "system B" },
        },
      ],
      name: "before_prompt_build concatenates prependContext and preserves systemPrompt precedence",
    },
    {
      expected: {
        appendSystemContext: "append A\n\nappend B",
        prependSystemContext: "prepend A\n\nprepend B",
      },
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "first",
          priority: 10,
          result: {
            appendSystemContext: "append A",
            prependSystemContext: "prepend A",
          },
        },
        {
          pluginId: "second",
          priority: 1,
          result: {
            appendSystemContext: "append B",
            prependSystemContext: "prepend B",
          },
        },
      ],
      name: "before_prompt_build concatenates prependSystemContext and appendSystemContext",
    },
  ] as const)("$name", async ({ hookName, hooks, expected }) => {
    await expectPhaseHookMerge({ expected, hookName, hooks });
  });
});
