/**
 * Test: subagent_spawning, subagent_delivery_target, subagent_spawned & subagent_ended hook wiring
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

describe("subagent hook runner methods", () => {
  const baseRequester = {
    accountId: "work",
    channel: "discord",
    threadId: "456",
    to: "channel:123",
  };

  const baseSubagentCtx = {
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    runId: "run-1",
  };

  async function invokeSubagentHook(params: {
    hookName:
      | "subagent_spawning"
      | "subagent_spawned"
      | "subagent_delivery_target"
      | "subagent_ended";
    event: Record<string, unknown>;
    ctx: Record<string, unknown>;
    handlerResult?: unknown;
  }) {
    const handler = vi.fn(async () => ({ status: "ok", threadBindingReady: true as const }));
    if (params.handlerResult !== undefined) {
      handler.mockResolvedValue(params.handlerResult as never);
    }
    const { runner } = createHookRunnerWithRegistry([{ handler, hookName: params.hookName }]);
    const result =
      params.hookName === "subagent_spawning"
        ? await runner.runSubagentSpawning(params.event as never, params.ctx as never)
        : params.hookName === "subagent_spawned"
          ? await runner.runSubagentSpawned(params.event as never, params.ctx as never)
          : params.hookName === "subagent_delivery_target"
            ? await runner.runSubagentDeliveryTarget(params.event as never, params.ctx as never)
            : await runner.runSubagentEnded(params.event as never, params.ctx as never);

    expect(handler).toHaveBeenCalledWith(params.event, params.ctx);
    return result;
  }

  it.each([
    {
      ctx: {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
      },
      event: {
        agentId: "main",
        childSessionKey: "agent:main:subagent:child",
        label: "research",
        mode: "session" as const,
        requester: baseRequester,
        threadRequested: true,
      },
      expectedResult: { status: "ok", threadBindingReady: true },
      handlerResult: { status: "ok", threadBindingReady: true as const },
      hookName: "subagent_spawning" as const,
      methodName: "runSubagentSpawning" as const,
      name: "runSubagentSpawning invokes registered subagent_spawning hooks",
    },
    {
      ctx: baseSubagentCtx,
      event: {
        agentId: "main",
        childSessionKey: "agent:main:subagent:child",
        label: "research",
        mode: "run" as const,
        requester: baseRequester,
        runId: "run-1",
        threadRequested: true,
      },
      hookName: "subagent_spawned" as const,
      methodName: "runSubagentSpawned" as const,
      name: "runSubagentSpawned invokes registered subagent_spawned hooks",
    },
    {
      ctx: baseSubagentCtx,
      event: {
        childRunId: "run-1",
        childSessionKey: "agent:main:subagent:child",
        expectsCompletionMessage: true,
        requesterOrigin: baseRequester,
        requesterSessionKey: "agent:main:main",
        spawnMode: "session" as const,
      },
      expectedResult: {
        origin: {
          accountId: "work",
          channel: "discord",
          threadId: "777",
          to: "channel:777",
        },
      },
      handlerResult: {
        origin: {
          accountId: "work",
          channel: "discord" as const,
          threadId: "777",
          to: "channel:777",
        },
      },
      hookName: "subagent_delivery_target" as const,
      methodName: "runSubagentDeliveryTarget" as const,
      name: "runSubagentDeliveryTarget invokes registered subagent_delivery_target hooks",
    },
    {
      ctx: baseSubagentCtx,
      event: {
        accountId: "work",
        outcome: "ok" as const,
        reason: "subagent-complete",
        runId: "run-1",
        sendFarewell: true,
        targetKind: "subagent" as const,
        targetSessionKey: "agent:main:subagent:child",
      },
      hookName: "subagent_ended" as const,
      methodName: "runSubagentEnded" as const,
      name: "runSubagentEnded invokes registered subagent_ended hooks",
    },
  ] as const)("$name", async ({ hookName, event, ctx, handlerResult, expectedResult }) => {
    const result = await invokeSubagentHook({ ctx, event, handlerResult, hookName });
    if (expectedResult !== undefined) {
      expect(result).toEqual(expectedResult);
      return;
    }
    expect(result).toBeUndefined();
  });

  it("runSubagentDeliveryTarget returns undefined when no matching hooks are registered", async () => {
    const { runner } = createHookRunnerWithRegistry([]);
    const result = await runner.runSubagentDeliveryTarget(
      {
        childRunId: "run-1",
        childSessionKey: "agent:main:subagent:child",
        expectsCompletionMessage: true,
        requesterOrigin: baseRequester,
        requesterSessionKey: "agent:main:main",
        spawnMode: "session",
      },
      baseSubagentCtx,
    );
    expect(result).toBeUndefined();
  });

  it("hasHooks returns true for registered subagent hooks", () => {
    const { runner } = createHookRunnerWithRegistry([
      { handler: vi.fn(), hookName: "subagent_spawning" },
      { handler: vi.fn(), hookName: "subagent_delivery_target" },
    ]);

    expect(runner.hasHooks("subagent_spawning")).toBe(true);
    expect(runner.hasHooks("subagent_delivery_target")).toBe(true);
    expect(runner.hasHooks("subagent_spawned")).toBe(false);
    expect(runner.hasHooks("subagent_ended")).toBe(false);
  });
});
