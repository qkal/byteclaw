import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { TEST_PLUGIN_AGENT_CTX, createMockPluginRegistry } from "./hooks.test-helpers.js";

const EVENT = { cleanedBody: "hello world" };

describe("before_agent_reply hook runner (claiming pattern)", () => {
  it("returns the result when a plugin claims with { handled: true }", async () => {
    const handler = vi.fn().mockResolvedValue({
      handled: true,
      reason: "test-claim",
      reply: { text: "intercepted" },
    });
    const registry = createMockPluginRegistry([{ handler, hookName: "before_agent_reply" }]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result).toEqual({
      handled: true,
      reason: "test-claim",
      reply: { text: "intercepted" },
    });
    expect(handler).toHaveBeenCalledWith(EVENT, TEST_PLUGIN_AGENT_CTX);
  });

  it("returns undefined when no hooks are registered", async () => {
    const registry = createMockPluginRegistry([]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result).toBeUndefined();
  });

  it("stops at first { handled: true } — second handler is not called", async () => {
    const first = vi.fn().mockResolvedValue({ handled: true, reply: { text: "first" } });
    const second = vi.fn().mockResolvedValue({ handled: true, reply: { text: "second" } });
    const registry = createMockPluginRegistry([
      { handler: first, hookName: "before_agent_reply" },
      { handler: second, hookName: "before_agent_reply" },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result).toEqual({ handled: true, reply: { text: "first" } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("returns { handled: true } without reply (swallow pattern)", async () => {
    const handler = vi.fn().mockResolvedValue({ handled: true });
    const registry = createMockPluginRegistry([{ handler, hookName: "before_agent_reply" }]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result).toEqual({ handled: true });
    expect(result?.reply).toBeUndefined();
  });

  it("skips a declining plugin (returns void) and lets the next one claim", async () => {
    const decliner = vi.fn().mockResolvedValue(undefined);
    const claimer = vi.fn().mockResolvedValue({
      handled: true,
      reply: { text: "claimed" },
    });
    const registry = createMockPluginRegistry([
      { handler: decliner, hookName: "before_agent_reply" },
      { handler: claimer, hookName: "before_agent_reply" },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result).toEqual({ handled: true, reply: { text: "claimed" } });
    expect(decliner).toHaveBeenCalledTimes(1);
    expect(claimer).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when all plugins decline", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const registry = createMockPluginRegistry([
      { handler: first, hookName: "before_agent_reply" },
      { handler: second, hookName: "before_agent_reply" },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result).toBeUndefined();
  });

  it("catches errors with catchErrors: true and continues to next handler", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const claimer = vi.fn().mockResolvedValue({ handled: true, reply: { text: "ok" } });
    const registry = createMockPluginRegistry([
      { handler: failing, hookName: "before_agent_reply" },
      { handler: claimer, hookName: "before_agent_reply" },
    ]);
    const runner = createHookRunner(registry, { logger });

    const result = await runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result).toEqual({ handled: true, reply: { text: "ok" } });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("before_agent_reply handler from test-plugin failed: Error: boom"),
    );
  });

  it("hasHooks reports correctly for before_agent_reply", () => {
    const registry = createMockPluginRegistry([
      { handler: vi.fn(), hookName: "before_agent_reply" },
    ]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("before_agent_reply")).toBe(true);
    expect(runner.hasHooks("before_agent_start")).toBe(false);
  });
});
