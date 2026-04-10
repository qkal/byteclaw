import type { AssistantMessage } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  loadRunOverflowCompactionHarness,
  mockedEnsureRuntimePluginsLoaded,
  mockedRunEmbeddedAttempt,
} from "./run.overflow-compaction.harness.js";
import { buildAttemptReplayMetadata } from "./run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  const toolMetas = overrides.toolMetas ?? [];
  const didSendViaMessagingTool = overrides.didSendViaMessagingTool ?? false;
  const { successfulCronAdds } = overrides;
  return {
    aborted: false,
    assistantTexts: [],
    cloudCodeAssistFormatError: false,
    didSendViaMessagingTool,
    idleTimedOut: false,
    itemLifecycle: {
      activeCount: 0,
      completedCount: 0,
      startedCount: 0,
    },
    lastAssistant: undefined,
    messagesSnapshot: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSentTexts: [],
    promptError: null,
    promptErrorSource: null,
    replayMetadata:
      overrides.replayMetadata ??
      buildAttemptReplayMetadata({
        didSendViaMessagingTool,
        successfulCronAdds,
        toolMetas,
      }),
    sessionIdUsed: "test-session",
    timedOut: false,
    timedOutDuringCompaction: false,
    toolMetas,
    ...overrides,
  };
}

function makeAssistantMessage(
  overrides: Partial<AssistantMessage> = {},
): NonNullable<EmbeddedRunAttemptResult["lastAssistant"]> {
  return {
    api: "openai-responses",
    content: [],
    model: "gpt-5.4",
    provider: "openai",
    role: "assistant",
    stopReason: "end_turn" as AssistantMessage["stopReason"],
    timestamp: Date.now(),
    usage: { input: 0, output: 0 } as AssistantMessage["usage"],
    ...overrides,
  };
}

describe("runEmbeddedPiAgent usage reporting", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedEnsureRuntimePluginsLoaded.mockReset();
    mockedRunEmbeddedAttempt.mockReset();
  });

  it("bootstraps runtime plugins with the resolved workspace before running", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedPiAgent({
      prompt: "hello",
      runId: "run-plugin-bootstrap",
      sessionFile: "/tmp/session.json",
      sessionId: "test-session",
      sessionKey: "test-key",
      timeoutMs: 30_000,
      workspaceDir: "/tmp/workspace",
    });

    expect(mockedEnsureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("forwards gateway subagent binding opt-in to runtime plugin bootstrap", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedPiAgent({
      allowGatewaySubagentBinding: true,
      prompt: "hello",
      runId: "run-gateway-bind",
      sessionFile: "/tmp/session.json",
      sessionId: "test-session",
      sessionKey: "test-key",
      timeoutMs: 30_000,
      workspaceDir: "/tmp/workspace",
    });

    expect(mockedEnsureRuntimePluginsLoaded).toHaveBeenCalledWith({
      allowGatewaySubagentBinding: true,
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
      }),
    );
  });

  it("forwards sender identity fields into embedded attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedPiAgent({
      prompt: "hello",
      runId: "run-sender-forwarding",
      senderE164: "+15551234567",
      senderId: "user-123",
      senderName: "Josh Lehman",
      senderUsername: "josh",
      sessionFile: "/tmp/session.json",
      sessionId: "test-session",
      sessionKey: "test-key",
      timeoutMs: 30_000,
      workspaceDir: "/tmp/workspace",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        senderE164: "+15551234567",
        senderId: "user-123",
        senderName: "Josh Lehman",
        senderUsername: "josh",
      }),
    );
  });

  it("forwards memory flush write paths into memory-triggered attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
      }),
    );

    await runEmbeddedPiAgent({
      memoryFlushWritePath: "memory/2026-03-10.md",
      prompt: "flush",
      runId: "run-memory-forwarding",
      sessionFile: "/tmp/session.json",
      sessionId: "test-session",
      sessionKey: "test-key",
      timeoutMs: 30_000,
      trigger: "memory",
      workspaceDir: "/tmp/workspace",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryFlushWritePath: "memory/2026-03-10.md",
        trigger: "memory",
      }),
    );
  });

  it("reports total usage from the last turn instead of accumulated total", async () => {
    // Simulate a multi-turn run result.
    // Turn 1: Input 100, Output 50. Total 150.
    // Turn 2: Input 150, Output 50. Total 200.

    // The accumulated usage (attemptUsage) will be the sum:
    // Input: 100 + 150 = 250 (Note: runEmbeddedAttempt actually returns accumulated usage)
    // Output: 50 + 50 = 100
    // Total: 150 + 200 = 350

    // The last assistant usage (lastAssistant.usage) will be Turn 2:
    // Input: 150, Output 50, Total 200.

    // We expect result.meta.agentMeta.usage.total to be 200 (last turn total).
    // The bug causes it to be 350 (accumulated total).

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1", "Response 2"],
        attemptUsage: { input: 250, output: 100, total: 350 },
        lastAssistant: makeAssistantMessage({
          usage: { input: 150, output: 50, total: 200 } as unknown as AssistantMessage["usage"],
        }),
      }),
    );

    const result = await runEmbeddedPiAgent({
      prompt: "hello",
      runId: "run-1",
      sessionFile: "/tmp/session.json",
      sessionId: "test-session",
      sessionKey: "test-key",
      timeoutMs: 30_000,
      workspaceDir: "/tmp/workspace",
    });

    // Check usage in meta
    const usage = result.meta.agentMeta?.usage;
    expect(usage).toBeDefined();

    // Check if total matches the last turn's total (200)
    // If the bug exists, it will likely be 350
    expect(usage?.total).toBe(200);
  });
});
