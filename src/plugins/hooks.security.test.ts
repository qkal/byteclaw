import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks } from "./hooks.test-helpers.js";
import { type PluginRegistry, createEmptyPluginRegistry } from "./registry.js";
import type { PluginHookBeforeToolCallResult, PluginHookMessageSendingResult } from "./types.js";

const toolEvent = { params: { command: "echo hello" }, toolName: "bash" };
const toolCtx = { toolName: "bash" };
const messageEvent = { content: "hello", to: "user-1" };
const messageCtx = { channelId: "telegram" };

async function runBeforeToolCallWithHooks(
  registry: PluginRegistry,
  hooks: readonly {
    pluginId: string;
    result: PluginHookBeforeToolCallResult;
    priority?: number;
    handler?: () => PluginHookBeforeToolCallResult | Promise<PluginHookBeforeToolCallResult>;
  }[],
  catchErrors = true,
) {
  addStaticTestHooks(registry, {
    hookName: "before_tool_call",
    hooks,
  });
  const runner = createHookRunner(registry, { catchErrors });
  return await runner.runBeforeToolCall(toolEvent, toolCtx);
}

async function runMessageSendingWithHooks(
  registry: PluginRegistry,
  hooks: readonly {
    pluginId: string;
    result: PluginHookMessageSendingResult;
    priority?: number;
    handler?: () => PluginHookMessageSendingResult | Promise<PluginHookMessageSendingResult>;
  }[],
  catchErrors = true,
) {
  addStaticTestHooks(registry, {
    hookName: "message_sending",
    hooks,
  });
  const runner = createHookRunner(registry, { catchErrors });
  return await runner.runMessageSending(messageEvent, messageCtx);
}

function expectTerminalHookState<
  TResult extends { block?: boolean; blockReason?: string; cancel?: boolean; content?: string },
>(result: TResult | undefined, expected: Partial<TResult>) {
  if ("block" in expected) {
    expect(result?.block).toBe(expected.block);
  }
  if ("blockReason" in expected) {
    expect(result?.blockReason).toBe(expected.blockReason);
  }
  if ("cancel" in expected) {
    expect(result?.cancel).toBe(expected.cancel);
  }
  if ("content" in expected) {
    expect(result?.content).toBe(expected.content);
  }
}

describe("before_tool_call terminal block semantics", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it.each([
    {
      expected: { block: true, blockReason: "dangerous" },
      hooks: [
        { pluginId: "high", priority: 100, result: { block: true, blockReason: "dangerous" } },
        { pluginId: "low", priority: 10, result: { block: false } },
      ],
      name: "keeps block=true when a lower-priority hook returns block=false",
    },
    {
      expected: { block: undefined },
      hooks: [{ pluginId: "single", priority: 10, result: { block: false } }],
      name: "treats explicit block=false as no-op when no prior hook blocked",
    },
    {
      expected: { block: true, blockReason: "blocked" },
      hooks: [
        { pluginId: "high", priority: 100, result: { block: true, blockReason: "blocked" } },
        { pluginId: "passive", priority: 10, result: {} },
      ],
      name: "treats passive handler output as no-op for prior block",
    },
    {
      expected: { block: true, blockReason: "mid" },
      hooks: [
        { pluginId: "high-passive", priority: 100, result: {} },
        { pluginId: "middle-block", priority: 50, result: { block: true, blockReason: "mid" } },
        { pluginId: "low-false", priority: 0, result: { block: false } },
      ],
      name: "respects block from a middle hook in a multi-handler chain",
    },
  ] as const)("$name", async ({ hooks, expected }) => {
    const result = await runBeforeToolCallWithHooks(registry, hooks);
    expectTerminalHookState(result, expected);
  });

  it("short-circuits lower-priority hooks after block=true", async () => {
    const high = vi.fn().mockReturnValue({ block: true, blockReason: "stop" });
    const low = vi.fn().mockReturnValue({ params: { injected: true } });
    const result = await runBeforeToolCallWithHooks(registry, [
      {
        handler: high,
        pluginId: "high",
        priority: 100,
        result: { block: true, blockReason: "stop" },
      },
      { handler: low, pluginId: "low", priority: 10, result: { params: { injected: true } } },
    ]);

    expect(result?.block).toBe(true);
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
  });

  it("preserves deterministic same-priority registration order when terminal hook runs first", async () => {
    const first = vi.fn().mockReturnValue({ block: true, blockReason: "first" });
    const second = vi.fn().mockReturnValue({ block: true, blockReason: "second" });
    const result = await runBeforeToolCallWithHooks(registry, [
      {
        handler: first,
        pluginId: "first",
        priority: 50,
        result: { block: true, blockReason: "first" },
      },
      {
        handler: second,
        pluginId: "second",
        priority: 50,
        result: { block: true, blockReason: "second" },
      },
    ]);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("first");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("stops before lower-priority throwing hooks when catchErrors is false", async () => {
    const low = vi.fn().mockImplementation(() => {
      throw new Error("should not run");
    });
    const result = await runBeforeToolCallWithHooks(
      registry,
      [
        { pluginId: "high", priority: 100, result: { block: true, blockReason: "guard" } },
        { handler: low, pluginId: "low", priority: 10, result: {} },
      ],
      false,
    );

    expect(result?.block).toBe(true);
    expect(low).not.toHaveBeenCalled();
  });

  it("throws for before_tool_call when configured as fail-closed", async () => {
    addStaticTestHooks(registry, {
      hookName: "before_tool_call",
      hooks: [
        {
          handler: () => {
            throw new Error("boom");
          },
          pluginId: "failing",
          priority: 100,
          result: {},
        },
      ],
    });
    const runner = createHookRunner(registry, {
      catchErrors: true,
      failurePolicyByHook: {
        before_tool_call: "fail-closed",
      },
    });

    await expect(runner.runBeforeToolCall(toolEvent, toolCtx)).rejects.toThrow(
      "before_tool_call handler from failing failed: Error: boom",
    );
  });
});

describe("message_sending terminal cancel semantics", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it.each([
    {
      expected: { cancel: true, content: "guarded" },
      hooks: [
        { pluginId: "high", priority: 100, result: { cancel: true, content: "guarded" } },
        { pluginId: "low", priority: 10, result: { cancel: false, content: "override" } },
      ],
      name: "keeps cancel=true when a lower-priority hook returns cancel=false",
    },
    {
      expected: { cancel: undefined },
      hooks: [{ pluginId: "single", priority: 10, result: { cancel: false } }],
      name: "treats explicit cancel=false as no-op when no prior hook canceled",
    },
    {
      expected: { cancel: true },
      hooks: [
        { pluginId: "high", priority: 100, result: { cancel: true } },
        { pluginId: "passive", priority: 10, result: {} },
      ],
      name: "treats passive handler output as no-op for prior cancel",
    },
    {
      expected: { cancel: true },
      hooks: [
        { pluginId: "high-passive", priority: 100, result: { content: "rewritten" } },
        { pluginId: "low-cancel", priority: 10, result: { cancel: true } },
      ],
      name: "allows lower-priority cancel when higher-priority hooks are non-terminal",
    },
  ] as const)("$name", async ({ hooks, expected }) => {
    const result = await runMessageSendingWithHooks(registry, hooks);
    expectTerminalHookState(result, expected);
  });

  it("short-circuits lower-priority hooks after cancel=true", async () => {
    const high = vi.fn().mockReturnValue({ cancel: true, content: "guarded" });
    const low = vi.fn().mockReturnValue({ cancel: false, content: "mutated" });
    const result = await runMessageSendingWithHooks(registry, [
      {
        handler: high,
        pluginId: "high",
        priority: 100,
        result: { cancel: true, content: "guarded" },
      },
      {
        handler: low,
        pluginId: "low",
        priority: 10,
        result: { cancel: false, content: "mutated" },
      },
    ]);

    expect(result?.cancel).toBe(true);
    expect(result?.content).toBe("guarded");
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
  });

  it("preserves deterministic same-priority registration order for non-terminal merges", async () => {
    const result = await runMessageSendingWithHooks(registry, [
      { pluginId: "first", priority: 50, result: { content: "first" } },
      { pluginId: "second", priority: 50, result: { content: "second" } },
    ]);

    expect(result?.content).toBe("second");
  });

  it("stops before lower-priority throwing hooks when catchErrors is false", async () => {
    const low = vi.fn().mockImplementation(() => {
      throw new Error("should not run");
    });
    const result = await runMessageSendingWithHooks(
      registry,
      [
        { pluginId: "high", priority: 100, result: { cancel: true } },
        { handler: low, pluginId: "low", priority: 10, result: {} },
      ],
      false,
    );

    expect(result?.cancel).toBe(true);
    expect(low).not.toHaveBeenCalled();
  });
});
