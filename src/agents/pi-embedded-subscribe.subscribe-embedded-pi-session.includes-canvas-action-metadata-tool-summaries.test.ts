import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  it("includes canvas action metadata in tool summaries", async () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      onToolResult,
      runId: "run-canvas-tool",
      verboseLevel: "on",
    });

    toolHarness.emit({
      args: { action: "a2ui_push", jsonlPath: "/tmp/a2ui.jsonl" },
      toolCallId: "tool-canvas-1",
      toolName: "canvas",
      type: "tool_execution_start",
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = onToolResult.mock.calls[0][0];
    expect(payload.text).toContain("🖼️");
    expect(payload.text).toContain("Canvas");
    expect(payload.text).toContain("/tmp/a2ui.jsonl");
  });
  it("skips tool summaries when shouldEmitToolResult is false", () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      onToolResult,
      runId: "run-tool-off",
      shouldEmitToolResult: () => false,
    });

    toolHarness.emit({
      args: { path: "/tmp/b.txt" },
      toolCallId: "tool-2",
      toolName: "read",
      type: "tool_execution_start",
    });

    expect(onToolResult).not.toHaveBeenCalled();
  });
  it("emits tool summaries when shouldEmitToolResult overrides verbose", async () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      onToolResult,
      runId: "run-tool-override",
      shouldEmitToolResult: () => true,
      verboseLevel: "off",
    });

    toolHarness.emit({
      args: { path: "/tmp/c.txt" },
      toolCallId: "tool-3",
      toolName: "read",
      type: "tool_execution_start",
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
  });
});
