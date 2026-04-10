import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

const hookMocks = vi.hoisted(() => ({
  consumeAdjustedParamsForToolCall: vi.fn((_: string) => undefined as unknown),
  isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
  runner: {
    hasHooks: vi.fn((_: string) => true),
    runAfterToolCall: vi.fn(async () => {}),
  },
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("./pi-tools.before-tool-call.js", () => ({
  consumeAdjustedParamsForToolCall: hookMocks.consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook: hookMocks.isToolWrappedWithBeforeToolCallHook,
  runBeforeToolCallHook: hookMocks.runBeforeToolCallHook,
}));

function createReadTool() {
  return {
    description: "reads",
    execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
    label: "Read",
    name: "read",
    parameters: Type.Object({}),
  } satisfies AgentTool;
}

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

describe("pi tool definition adapter after_tool_call", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.runAfterToolCall.mockClear();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockClear();
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(false);
    hookMocks.consumeAdjustedParamsForToolCall.mockClear();
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue(undefined);
    hookMocks.runBeforeToolCallHook.mockClear();
    hookMocks.runBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  // Regression guard: after_tool_call is handled exclusively by
  // HandleToolExecutionEnd in the subscription handler to prevent
  // Duplicate invocations in embedded runs.
  it("does not fire after_tool_call from the adapter (handled by subscription handler)", async () => {
    const defs = toToolDefinitions([createReadTool()]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    await def.execute("call-ok", { path: "/tmp/file" }, undefined, undefined, extensionContext);

    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("does not fire after_tool_call from the adapter on error", async () => {
    const tool = {
      description: "throws",
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
      label: "Bash",
      name: "bash",
      parameters: Type.Object({}),
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    await def.execute("call-err", { cmd: "ls" }, undefined, undefined, extensionContext);

    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("does not consume adjusted params in adapter for wrapped tools", async () => {
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(true);
    const defs = toToolDefinitions([createReadTool()]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    await def.execute(
      "call-wrapped",
      { path: "/tmp/file" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
    expect(hookMocks.consumeAdjustedParamsForToolCall).not.toHaveBeenCalled();
  });
});
