/**
 * Test: gateway_start & gateway_stop hook wiring (server.impl.ts)
 *
 * Since startGatewayServer is heavily integrated, we test the hook runner
 * calls at the unit level by verifying the hook runner functions exist
 * and validating the integration pattern.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";
import type {
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
} from "./types.js";

async function expectGatewayHookCall(params: {
  hookName: "gateway_start" | "gateway_stop";
  event: PluginHookGatewayStartEvent | PluginHookGatewayStopEvent;
  gatewayCtx: PluginHookGatewayContext;
}) {
  const handler = vi.fn();
  const { runner } = createHookRunnerWithRegistry([{ handler, hookName: params.hookName }]);

  if (params.hookName === "gateway_start") {
    await runner.runGatewayStart(params.event as PluginHookGatewayStartEvent, params.gatewayCtx);
  } else {
    await runner.runGatewayStop(params.event as PluginHookGatewayStopEvent, params.gatewayCtx);
  }

  expect(handler).toHaveBeenCalledWith(params.event, params.gatewayCtx);
}

describe("gateway hook runner methods", () => {
  const gatewayCtx = { port: 18_789 };

  it.each([
    {
      event: { port: 18_789 },
      hookName: "gateway_start" as const,
      name: "runGatewayStart invokes registered gateway_start hooks",
    },
    {
      event: { reason: "test shutdown" },
      hookName: "gateway_stop" as const,
      name: "runGatewayStop invokes registered gateway_stop hooks",
    },
  ] as const)("$name", async ({ hookName, event }) => {
    await expectGatewayHookCall({ event, gatewayCtx, hookName });
  });

  it("hasHooks returns true for registered gateway hooks", () => {
    const { runner } = createHookRunnerWithRegistry([
      { handler: vi.fn(), hookName: "gateway_start" },
    ]);

    expect(runner.hasHooks("gateway_start")).toBe(true);
    expect(runner.hasHooks("gateway_stop")).toBe(false);
  });
});
