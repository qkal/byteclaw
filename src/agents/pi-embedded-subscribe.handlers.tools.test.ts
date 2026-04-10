import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { MessagingToolSend } from "./pi-embedded-messaging.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./pi-embedded-subscribe.handlers.types.js";

type ToolExecutionStartEvent = Extract<AgentEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;

function createTestContext(): {
  ctx: ToolHandlerContext;
  warn: ReturnType<typeof vi.fn>;
  onBlockReplyFlush: ReturnType<typeof vi.fn>;
  onAgentEvent: ReturnType<typeof vi.fn>;
} {
  const onBlockReplyFlush = vi.fn();
  const onAgentEvent = vi.fn();
  const warn = vi.fn();
  const ctx: ToolHandlerContext = {
    emitToolOutput: vi.fn(),
    emitToolSummary: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: undefined,
    log: {
      debug: vi.fn(),
      warn,
    },
    params: {
      onAgentEvent,
      onBlockReplyFlush,
      onToolResult: undefined,
      runId: "run-test",
    },
    shouldEmitToolOutput: () => false,
    shouldEmitToolResult: () => false,
    state: {
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      itemActiveIds: new Set<string>(),
      itemCompletedCount: 0,
      itemStartedCount: 0,
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      pendingMessagingMediaUrls: new Map<string, string[]>(),
      pendingMessagingTargets: new Map<string, MessagingToolSend>(),
      pendingMessagingTexts: new Map<string, string>(),
      pendingToolAudioAsVoice: false,
      pendingToolMediaUrls: [],
      successfulCronAdds: 0,
      toolMetaById: new Map<string, ToolCallSummary>(),
      toolMetas: [],
      toolSummaryById: new Set<string>(),
    },
    trimMessagingToolSent: vi.fn(),
  };

  return { ctx, onAgentEvent, onBlockReplyFlush, warn };
}

describe("handleToolExecutionStart read path checks", () => {
  it("does not warn when read tool uses file_path alias", async () => {
    const { ctx, warn, onBlockReplyFlush } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      args: { file_path: "/tmp/example.txt" },
      toolCallId: "tool-1",
      toolName: "read",
      type: "tool_execution_start",
    };

    await handleToolExecutionStart(ctx, evt);

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when read tool has neither path nor file_path", async () => {
    const { ctx, warn } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      args: {},
      toolCallId: "tool-2",
      toolName: "read",
      type: "tool_execution_start",
    };

    await handleToolExecutionStart(ctx, evt);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("read tool called without path");
  });

  it("awaits onBlockReplyFlush before continuing tool start processing", async () => {
    const { ctx, onBlockReplyFlush } = createTestContext();
    let releaseFlush: (() => void) | undefined;
    onBlockReplyFlush.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
    );

    const evt: ToolExecutionStartEvent = {
      args: { command: "echo hi" },
      toolCallId: "tool-await-flush",
      toolName: "exec",
      type: "tool_execution_start",
    };

    const pending = handleToolExecutionStart(ctx, evt);
    // Let the async function reach the awaited flush Promise.
    await Promise.resolve();

    // If flush isn't awaited, tool metadata would already be recorded here.
    expect(ctx.state.toolMetaById.has("tool-await-flush")).toBe(false);
    expect(releaseFlush).toBeTypeOf("function");

    releaseFlush?.();
    await pending;

    expect(ctx.state.toolMetaById.has("tool-await-flush")).toBe(true);
    expect(ctx.state.itemStartedCount).toBe(2);
    expect(ctx.state.itemActiveIds.has("tool:tool-await-flush")).toBe(true);
    expect(ctx.state.itemActiveIds.has("command:tool-await-flush")).toBe(true);
  });
});

describe("handleToolExecutionEnd cron.add commitment tracking", () => {
  it("increments successfulCronAdds when cron add succeeds", async () => {
    const { ctx } = createTestContext();
    await handleToolExecutionStart(
      ctx as never,
      {
        args: { action: "add", job: { name: "reminder" } },
        toolCallId: "tool-cron-1",
        toolName: "cron",
        type: "tool_execution_start",
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: { details: { status: "ok" } },
        toolCallId: "tool-cron-1",
        toolName: "cron",
        type: "tool_execution_end",
      } as never,
    );

    expect(ctx.state.successfulCronAdds).toBe(1);
  });

  it("does not increment successfulCronAdds when cron add fails", async () => {
    const { ctx } = createTestContext();
    await handleToolExecutionStart(
      ctx as never,
      {
        args: { action: "add", job: { name: "reminder" } },
        toolCallId: "tool-cron-2",
        toolName: "cron",
        type: "tool_execution_start",
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: true,
        result: { details: { status: "error" } },
        toolCallId: "tool-cron-2",
        toolName: "cron",
        type: "tool_execution_end",
      } as never,
    );

    expect(ctx.state.successfulCronAdds).toBe(0);
    expect(ctx.state.itemCompletedCount).toBe(1);
    expect(ctx.state.itemActiveIds.size).toBe(0);
  });
});

describe("handleToolExecutionEnd mutating failure recovery", () => {
  it("clears edit failure when the retry succeeds through common file path aliases", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        args: {
          file_path: "/tmp/demo.txt",
          new_string: "beta fixed",
          old_string: "beta stale",
        },
        toolCallId: "tool-edit-1",
        toolName: "edit",
        type: "tool_execution_start",
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: true,
        result: { error: "Could not find the exact text in /tmp/demo.txt" },
        toolCallId: "tool-edit-1",
        toolName: "edit",
        type: "tool_execution_end",
      } as never,
    );

    expect(ctx.state.lastToolError?.toolName).toBe("edit");

    await handleToolExecutionStart(
      ctx as never,
      {
        args: {
          file: "/tmp/demo.txt",
          newText: "beta fixed",
          oldText: "beta",
        },
        toolCallId: "tool-edit-2",
        toolName: "edit",
        type: "tool_execution_start",
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: { ok: true },
        toolCallId: "tool-edit-2",
        toolName: "edit",
        type: "tool_execution_end",
      } as never,
    );

    expect(ctx.state.lastToolError).toBeUndefined();
  });
});

describe("handleToolExecutionEnd timeout metadata", () => {
  it("records timeout metadata for failed exec results", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: true,
        result: {
          content: [
            {
              text: "Command timed out after 1800 seconds.",
              type: "text",
            },
          ],
          details: {
            aggregated: "",
            durationMs: 1_800_000,
            exitCode: null,
            status: "failed",
            timedOut: true,
          },
        },
        toolCallId: "tool-exec-timeout",
        toolName: "exec",
        type: "tool_execution_end",
      } as never,
    );

    expect(ctx.state.lastToolError).toMatchObject({
      timedOut: true,
      toolName: "exec",
    });
  });
});

describe("handleToolExecutionEnd exec approval prompts", () => {
  it("emits a deterministic approval payload and marks assistant output suppressed", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: {
          details: {
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            command: "npm view diver name version description",
            cwd: "/tmp/work",
            expiresAtMs: 1_800_000_000_000,
            host: "gateway",
            status: "approval-pending",
            warningText: "Warning: heredoc execution requires explicit approval in allowlist mode.",
          },
        },
        toolCallId: "tool-exec-approval",
        toolName: "exec",
        type: "tool_execution_end",
      } as never,
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        channelData: {
          execApproval: expect.objectContaining({
            allowedDecisions: ["allow-once", "allow-always", "deny"],
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalKind: "exec",
            approvalSlug: "12345678",
          }),
        },
        interactive: expect.objectContaining({
          blocks: expect.any(Array),
        }),
        text: expect.stringContaining("```txt\n/approve 12345678 allow-once\n```"),
      }),
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("preserves filtered approval decisions from tool details", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: {
          details: {
            allowedDecisions: ["allow-once", "deny"],
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            command: "npm view diver name version description",
            expiresAtMs: 1_800_000_000_000,
            host: "gateway",
            status: "approval-pending",
          },
        },
        toolCallId: "tool-exec-approval-ask-always",
        toolName: "exec",
        type: "tool_execution_end",
      } as never,
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        channelData: {
          execApproval: expect.objectContaining({
            allowedDecisions: ["allow-once", "deny"],
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalKind: "exec",
            approvalSlug: "12345678",
          }),
        },
        interactive: expect.objectContaining({
          blocks: expect.any(Array),
        }),
        text: expect.not.stringContaining("allow-always"),
      }),
    );
  });

  it("emits a deterministic unavailable payload when the initiating surface cannot approve", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: {
          details: {
            accountId: "work",
            channel: "discord",
            channelLabel: "Discord",
            reason: "initiating-platform-disabled",
            status: "approval-unavailable",
          },
        },
        toolCallId: "tool-exec-unavailable",
        toolName: "exec",
        type: "tool_execution_end",
      } as never,
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("native chat exec approvals are not configured on Discord"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("/approve"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("Pending command:"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("Host:"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("CWD:"),
      }),
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("emits the shared approver-DM notice when another approval client received the request", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: {
          details: {
            channelLabel: "Telegram",
            reason: "initiating-platform-disabled",
            sentApproverDms: true,
            status: "approval-unavailable",
          },
        },
        toolCallId: "tool-exec-unavailable-dm-redirect",
        toolName: "exec",
        type: "tool_execution_end",
      } as never,
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Approval required. I sent approval DMs to the approvers for this account.",
      }),
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("does not suppress assistant output when deterministic prompt delivery rejects", async () => {
    const { ctx } = createTestContext();
    ctx.params.onToolResult = vi.fn(async () => {
      throw new Error("delivery failed");
    });

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: {
          details: {
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            command: "npm view diver name version description",
            cwd: "/tmp/work",
            expiresAtMs: 1_800_000_000_000,
            host: "gateway",
            status: "approval-pending",
          },
        },
        toolCallId: "tool-exec-approval-reject",
        toolName: "exec",
        type: "tool_execution_end",
      } as never,
    );

    expect(ctx.state.deterministicApprovalPromptSent).toBe(false);
  });

  it("emits approval + blocked command item events when exec needs approval", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        args: { command: "npm test" },
        toolCallId: "tool-exec-approval-events",
        toolName: "exec",
        type: "tool_execution_start",
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: {
          details: {
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            command: "npm test",
            host: "gateway",
            status: "approval-pending",
          },
        },
        toolCallId: "tool-exec-approval-events",
        toolName: "exec",
        type: "tool_execution_end",
      } as never,
    );

    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalId: "12345678-1234-1234-1234-123456789012",
          approvalSlug: "12345678",
          itemId: "command:tool-exec-approval-events",
          phase: "requested",
          status: "pending",
        }),
        stream: "approval",
      }),
    );
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          itemId: "command:tool-exec-approval-events",
          phase: "end",
          status: "blocked",
          summary: "Awaiting approval before command can run.",
        }),
        stream: "item",
      }),
    );
  });
});

describe("handleToolExecutionEnd derived tool events", () => {
  it("emits command output events for exec results", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        args: { command: "ls" },
        toolCallId: "tool-exec-output",
        toolName: "exec",
        type: "tool_execution_start",
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: {
          details: {
            aggregated: "README.md",
            cwd: "/tmp/work",
            durationMs: 10,
            exitCode: 0,
            status: "completed",
          },
        },
        toolCallId: "tool-exec-output",
        toolName: "exec",
        type: "tool_execution_end",
      } as never,
    );

    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cwd: "/tmp/work",
          exitCode: 0,
          itemId: "command:tool-exec-output",
          output: "README.md",
          phase: "end",
        }),
        stream: "command_output",
      }),
    );
  });

  it("emits patch summary events for apply_patch results", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        args: { patch: "*** Begin Patch" },
        toolCallId: "tool-patch-summary",
        toolName: "apply_patch",
        type: "tool_execution_start",
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        isError: false,
        result: {
          details: {
            summary: {
              added: ["a.ts"],
              deleted: ["c.ts"],
              modified: ["b.ts"],
            },
          },
        },
        toolCallId: "tool-patch-summary",
        toolName: "apply_patch",
        type: "tool_execution_end",
      } as never,
    );

    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          added: ["a.ts"],
          deleted: ["c.ts"],
          itemId: "patch:tool-patch-summary",
          modified: ["b.ts"],
          summary: "1 added, 1 modified, 1 deleted",
        }),
        stream: "patch",
      }),
    );
  });
});

describe("messaging tool media URL tracking", () => {
  it("tracks media arg from messaging tool as pending", async () => {
    const { ctx } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      args: { action: "send", content: "hi", media: "file:///img.jpg", to: "channel:123" },
      toolCallId: "tool-m1",
      toolName: "message",
      type: "tool_execution_start",
    };

    await handleToolExecutionStart(ctx, evt);

    expect(ctx.state.pendingMessagingMediaUrls.get("tool-m1")).toEqual(["file:///img.jpg"]);
  });

  it("commits pending media URL on tool success", async () => {
    const { ctx } = createTestContext();

    // Simulate start
    const startEvt: ToolExecutionStartEvent = {
      args: { action: "send", content: "hi", media: "file:///img.jpg", to: "channel:123" },
      toolCallId: "tool-m2",
      toolName: "message",
      type: "tool_execution_start",
    };

    await handleToolExecutionStart(ctx, startEvt);

    // Simulate successful end
    const endEvt: ToolExecutionEndEvent = {
      isError: false,
      result: { ok: true },
      toolCallId: "tool-m2",
      toolName: "message",
      type: "tool_execution_end",
    };

    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toContain("file:///img.jpg");
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-m2")).toBe(false);
  });

  it("commits mediaUrls from tool result payload", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      args: { action: "send", content: "hi", to: "channel:123" },
      toolCallId: "tool-m2b",
      toolName: "message",
      type: "tool_execution_start",
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      isError: false,
      result: {
        content: [
          {
            text: JSON.stringify({
              mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"],
            }),
            type: "text",
          },
        ],
      },
      toolCallId: "tool-m2b",
      toolName: "message",
      type: "tool_execution_end",
    };
    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toEqual([
      "file:///img-a.jpg",
      "file:///img-b.jpg",
    ]);
  });

  it("trims messagingToolSentMediaUrls to 200 on commit (FIFO)", async () => {
    const { ctx } = createTestContext();

    // Replace mock with a real trim that replicates production cap logic.
    const MAX = 200;
    ctx.trimMessagingToolSent = () => {
      if (ctx.state.messagingToolSentTexts.length > MAX) {
        const overflow = ctx.state.messagingToolSentTexts.length - MAX;
        ctx.state.messagingToolSentTexts.splice(0, overflow);
        ctx.state.messagingToolSentTextsNormalized.splice(0, overflow);
      }
      if (ctx.state.messagingToolSentTargets.length > MAX) {
        const overflow = ctx.state.messagingToolSentTargets.length - MAX;
        ctx.state.messagingToolSentTargets.splice(0, overflow);
      }
      if (ctx.state.messagingToolSentMediaUrls.length > MAX) {
        const overflow = ctx.state.messagingToolSentMediaUrls.length - MAX;
        ctx.state.messagingToolSentMediaUrls.splice(0, overflow);
      }
    };

    // Pre-fill with 200 URLs (url-0 .. url-199)
    for (let i = 0; i < 200; i++) {
      ctx.state.messagingToolSentMediaUrls.push(`file:///img-${i}.jpg`);
    }
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);

    // Commit one more via start → end
    const startEvt: ToolExecutionStartEvent = {
      args: { action: "send", content: "hi", media: "file:///img-new.jpg", to: "channel:123" },
      toolCallId: "tool-cap",
      toolName: "message",
      type: "tool_execution_start",
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      isError: false,
      result: { ok: true },
      toolCallId: "tool-cap",
      toolName: "message",
      type: "tool_execution_end",
    };
    await handleToolExecutionEnd(ctx, endEvt);

    // Should be capped at 200, oldest removed, newest appended.
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);
    expect(ctx.state.messagingToolSentMediaUrls[0]).toBe("file:///img-1.jpg");
    expect(ctx.state.messagingToolSentMediaUrls[199]).toBe("file:///img-new.jpg");
    expect(ctx.state.messagingToolSentMediaUrls).not.toContain("file:///img-0.jpg");
  });

  it("discards pending media URL on tool error", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      args: { action: "send", content: "hi", media: "file:///img.jpg", to: "channel:123" },
      toolCallId: "tool-m3",
      toolName: "message",
      type: "tool_execution_start",
    };

    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      isError: true,
      result: "Error: failed",
      toolCallId: "tool-m3",
      toolName: "message",
      type: "tool_execution_end",
    };

    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(0);
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-m3")).toBe(false);
  });
});
