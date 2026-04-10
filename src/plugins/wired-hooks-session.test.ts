/**
 * Test: session_start & session_end hook wiring
 *
 * Tests the hook runner methods directly since session init is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";
import type {
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
} from "./types.js";

async function expectSessionHookCall(params: {
  hookName: "session_start" | "session_end";
  event: PluginHookSessionStartEvent | PluginHookSessionEndEvent;
  sessionCtx: PluginHookSessionContext & { sessionKey: string; agentId: string };
}) {
  const handler = vi.fn();
  const { runner } = createHookRunnerWithRegistry([{ handler, hookName: params.hookName }]);

  if (params.hookName === "session_start") {
    await runner.runSessionStart(params.event as PluginHookSessionStartEvent, params.sessionCtx);
  } else {
    await runner.runSessionEnd(params.event as PluginHookSessionEndEvent, params.sessionCtx);
  }

  expect(handler).toHaveBeenCalledWith(params.event, params.sessionCtx);
}

describe("session hook runner methods", () => {
  const sessionCtx = { agentId: "main", sessionId: "abc-123", sessionKey: "agent:main:abc" };

  it.each([
    {
      event: { resumedFrom: "old-session", sessionId: "abc-123", sessionKey: "agent:main:abc" },
      hookName: "session_start" as const,
      name: "runSessionStart invokes registered session_start hooks",
    },
    {
      event: {
        messageCount: 42,
        nextSessionId: "def-456",
        reason: "daily" as const,
        sessionFile: "/tmp/abc-123.jsonl.reset.2026-04-02T10-00-00.000Z",
        sessionId: "abc-123",
        sessionKey: "agent:main:abc",
        transcriptArchived: true,
      },
      hookName: "session_end" as const,
      name: "runSessionEnd invokes registered session_end hooks",
    },
  ] as const)("$name", async ({ hookName, event }) => {
    await expectSessionHookCall({ event, hookName, sessionCtx });
  });

  it("hasHooks returns true for registered session hooks", () => {
    const { runner } = createHookRunnerWithRegistry([
      { handler: vi.fn(), hookName: "session_start" },
    ]);

    expect(runner.hasHooks("session_start")).toBe(true);
    expect(runner.hasHooks("session_end")).toBe(false);
  });
});
