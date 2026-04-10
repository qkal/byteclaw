import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { type HookRunnerLogger, createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

function createToolResultMessage(text: string): AgentMessage {
  return {
    content: [{ text, type: "text" }],
    isError: false,
    role: "toolResult",
    toolCallId: "call_1",
  } as AgentMessage;
}

function createLogger(): HookRunnerLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn<(message: string) => void>();
  const error = vi.fn<(message: string) => void>();
  return {
    error,
    warn,
  };
}

describe("sync-only plugin hooks", () => {
  it("warns and ignores accidental async tool_result_persist handlers", () => {
    const logger = createLogger();
    const originalMessage = createToolResultMessage("original");
    const replacementMessage = createToolResultMessage("replacement");
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          handler: async () => ({ message: replacementMessage }),
          hookName: "tool_result_persist",
          pluginId: "async-tool-result",
        },
      ]),
      { logger },
    );

    const result = runner.runToolResultPersist(
      { message: originalMessage },
      { agentId: "agent-1", sessionKey: "session-1" },
    );

    expect(result).toEqual({ message: originalMessage });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "tool_result_persist handler from async-tool-result returned a Promise",
      ),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("warns and ignores accidental async before_message_write handlers", () => {
    const logger = createLogger();
    const originalMessage = createToolResultMessage("original");
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          handler: async () => ({ block: true }),
          hookName: "before_message_write",
          pluginId: "async-before-write",
        },
      ]),
      { logger },
    );

    const result = runner.runBeforeMessageWrite(
      { agentId: "agent-1", message: originalMessage, sessionKey: "session-1" },
      { agentId: "agent-1", sessionKey: "session-1" },
    );

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "before_message_write handler from async-before-write returned a Promise",
      ),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
