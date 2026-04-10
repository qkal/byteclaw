import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks } from "./hooks.test-helpers.js";
import { type PluginRegistry, createEmptyPluginRegistry } from "./registry.js";
import type { PluginHookToolContext } from "./types.js";
import type { PluginHookBeforeToolCallResult } from "./types.js";

const stubCtx: PluginHookToolContext = {
  agentId: "main",
  sessionKey: "agent:main:main",
  toolName: "bash",
};

async function runBeforeToolCallWithHooks(
  registry: PluginRegistry,
  hooks: readonly {
    pluginId: string;
    result: PluginHookBeforeToolCallResult;
    priority?: number;
  }[],
) {
  addStaticTestHooks(registry, {
    hookName: "before_tool_call",
    hooks,
  });
  const runner = createHookRunner(registry);
  return await runner.runBeforeToolCall({ params: {}, toolName: "bash" }, stubCtx);
}

function expectRequireApprovalResult(
  result: PluginHookBeforeToolCallResult | undefined,
  expected: {
    block?: boolean;
    blockReason?: string;
    params?: Record<string, unknown>;
    requireApproval?: Record<string, unknown>;
  },
) {
  expect(result?.block).toBe(expected.block);
  expect(result?.blockReason).toBe(expected.blockReason);
  expect(result?.params).toEqual(expected.params);
  expect(result?.requireApproval).toEqual(
    expected.requireApproval ? expect.objectContaining(expected.requireApproval) : undefined,
  );
}

describe("before_tool_call hook merger — requireApproval", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it.each([
    {
      expectedApproval: {
        description: "This tool does something sensitive",
        id: "approval-1",
        pluginId: "sage",
        severity: "warning",
        title: "Sensitive tool",
      },
      hooks: [
        {
          pluginId: "sage",
          result: {
            requireApproval: {
              description: "This tool does something sensitive",
              id: "approval-1",
              severity: "warning",
              title: "Sensitive tool",
            },
          },
        },
      ],
      name: "propagates requireApproval from a single plugin",
    },
    {
      expectedApproval: {
        pluginId: "my-plugin",
      },
      hooks: [
        {
          pluginId: "my-plugin",
          result: {
            requireApproval: {
              description: "D",
              id: "a1",
              title: "T",
            },
          },
        },
      ],
      name: "stamps pluginId from the registration",
    },
    {
      expectedApproval: {
        pluginId: "plugin-a",
        title: "First",
      },
      hooks: [
        {
          pluginId: "plugin-a",
          priority: 100,
          result: {
            requireApproval: {
              description: "First plugin",
              title: "First",
            },
          },
        },
        {
          pluginId: "plugin-b",
          priority: 50,
          result: {
            requireApproval: {
              description: "Second plugin",
              title: "Second",
            },
          },
        },
      ],
      name: "first hook with requireApproval wins when multiple plugins set it",
    },
    {
      expectedApproval: {
        pluginId: "actual-plugin",
      },
      hooks: [
        {
          pluginId: "actual-plugin",
          result: {
            requireApproval: {
              description: "D",
              pluginId: "should-be-overwritten",
              title: "T",
            },
          },
        },
      ],
      name: "does not overwrite pluginId if plugin sets it (stamped by merger)",
    },
  ] as const)("$name", async ({ hooks, expectedApproval }) => {
    const result = await runBeforeToolCallWithHooks(registry, hooks);
    expectRequireApprovalResult(result, { requireApproval: expectedApproval });
  });

  it("merges block and requireApproval from different plugins", async () => {
    const result = await runBeforeToolCallWithHooks(registry, [
      {
        pluginId: "approver",
        priority: 100,
        result: {
          requireApproval: {
            description: "Approval needed",
            title: "Needs approval",
          },
        },
      },
      {
        pluginId: "blocker",
        priority: 50,
        result: {
          block: true,
          blockReason: "blocked",
        },
      },
    ]);
    expect(result?.block).toBe(true);
    expect(result?.requireApproval?.title).toBe("Needs approval");
  });

  it("returns undefined requireApproval when no plugin sets it", async () => {
    const result = await runBeforeToolCallWithHooks(registry, [
      { pluginId: "plain", result: { params: { extra: true } } },
    ]);
    expect(result?.requireApproval).toBeUndefined();
  });

  it.each([
    {
      expected: {
        params: { safe: true, source: "approver" },
        requireApproval: { pluginId: "approver" },
      },
      hooks: [
        {
          pluginId: "approver",
          priority: 100,
          result: {
            params: { safe: true, source: "approver" },
            requireApproval: {
              description: "Approval needed",
              title: "Needs approval",
            },
          },
        },
        {
          pluginId: "mutator",
          priority: 50,
          result: {
            params: { safe: false, source: "mutator" },
          },
        },
      ],
      name: "freezes params after requireApproval when a lower-priority plugin tries to override them",
    },
    {
      expected: {
        block: true,
        blockReason: "blocked",
        params: { safe: true, source: "approver" },
        requireApproval: { pluginId: "approver" },
      },
      hooks: [
        {
          pluginId: "approver",
          priority: 100,
          result: {
            params: { safe: true, source: "approver" },
            requireApproval: {
              description: "Approval needed",
              title: "Needs approval",
            },
          },
        },
        {
          pluginId: "blocker",
          priority: 50,
          result: {
            block: true,
            blockReason: "blocked",
            params: { safe: false, source: "blocker" },
          },
        },
      ],
      name: "still allows block=true from a lower-priority plugin after requireApproval",
    },
  ] as const)("$name", async ({ hooks, expected }) => {
    const result = await runBeforeToolCallWithHooks(registry, hooks);
    expectRequireApprovalResult(result, expected);
  });
});
