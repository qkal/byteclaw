/**
 * Test: message_sending & message_sent hook wiring
 *
 * Tests the hook runner methods directly since outbound delivery is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";
import type {
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
} from "./types.js";

async function expectMessageHookCall(params: {
  hookName: "message_sending" | "message_sent";
  event: PluginHookMessageSendingEvent | PluginHookMessageSentEvent;
  hookResult?: PluginHookMessageSendingResult;
  expectedResult?: PluginHookMessageSendingResult;
  channelCtx: { channelId: string };
}) {
  const handler =
    params.hookResult === undefined ? vi.fn() : vi.fn().mockReturnValue(params.hookResult);
  const { runner } = createHookRunnerWithRegistry([{ handler, hookName: params.hookName }]);

  if (params.hookName === "message_sending") {
    const result = await runner.runMessageSending(
      params.event as PluginHookMessageSendingEvent,
      params.channelCtx,
    );
    expect(result).toEqual(expect.objectContaining(params.expectedResult ?? {}));
  } else {
    await runner.runMessageSent(params.event as PluginHookMessageSentEvent, params.channelCtx);
  }

  expect(handler).toHaveBeenCalledWith(params.event, params.channelCtx);
}

describe("message_sending hook runner", () => {
  const demoChannelCtx = { channelId: "demo-channel" };
  it.each([
    {
      event: { content: "original content", to: "user-123" },
      expected: { content: "modified content" },
      hookResult: { content: "modified content" },
      name: "runMessageSending invokes registered hooks and returns modified content",
    },
    {
      event: { content: "blocked", to: "user-123" },
      expected: { cancel: true },
      hookResult: { cancel: true },
      name: "runMessageSending can cancel message delivery",
    },
  ] as const)("$name", async ({ event, hookResult, expected }) => {
    await expectMessageHookCall({
      channelCtx: demoChannelCtx,
      event,
      expectedResult: expected,
      hookName: "message_sending",
      hookResult,
    });
  });
});

describe("message_sent hook runner", () => {
  const demoChannelCtx = { channelId: "demo-channel" };

  it.each([
    {
      event: { content: "hello", success: true, to: "user-123" },
      name: "runMessageSent invokes registered hooks with success=true",
    },
    {
      event: { content: "hello", error: "timeout", success: false, to: "user-123" },
      name: "runMessageSent invokes registered hooks with error on failure",
    },
  ] as const)("$name", async ({ event }) => {
    await expectMessageHookCall({
      channelCtx: demoChannelCtx,
      event,
      hookName: "message_sent",
    });
  });
});
