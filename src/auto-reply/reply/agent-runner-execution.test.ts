import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import { MAX_LIVE_SWITCH_RETRIES } from "./agent-runner-execution.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingSignaler } from "./typing-mode.js";

const state = vi.hoisted(() => ({
  isInternalMessageChannelMock: vi.fn((_: unknown) => false),
  runEmbeddedPiAgentMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
  runWithModelFallback: (params: unknown) => state.runWithModelFallbackMock(params),
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: () => false,
  };
});

vi.mock("../../agents/bootstrap-budget.js", () => ({
  resolveBootstrapWarningSignaturesSeen: () => [],
}));

vi.mock("../../agents/pi-embedded-helpers.js", () => ({
  BILLING_ERROR_USER_MESSAGE: "billing",
  isBillingErrorMessage: () => false,
  isCompactionFailureError: () => false,
  isContextOverflowError: () => false,
  isLikelyContextOverflowError: () => false,
  isRateLimitErrorMessage: () => false,
  isTransientHttpError: () => false,
  sanitizeUserFacingText: (text?: string) => text ?? "",
}));

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn(() => null),
  resolveSessionTranscriptPath: vi.fn(),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
    "../../infra/agent-events.js",
  );
  return {
    ...actual,
    emitAgentEvent: vi.fn(),
    registerAgentRunContext: vi.fn(),
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
  },
}));

vi.mock("../../utils/message-channel.js", () => ({
  isInternalMessageChannel: (value: unknown) => state.isInternalMessageChannelMock(value),
  isMarkdownCapableMessageChannel: () => true,
  resolveMessageChannel: () => "whatsapp",
}));

vi.mock("../heartbeat.js", () => ({
  stripHeartbeatToken: (text: string) => ({
    didStrip: false,
    shouldSkip: false,
    text,
  }),
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildEmbeddedRunExecutionParams: (params: {
    provider: string;
    model: string;
    run: { provider?: string; authProfileId?: string; authProfileIdSource?: "auto" | "user" };
  }) => ({
    embeddedContext: {},
    runBaseParams: {
      authProfileId: params.provider === params.run.provider ? params.run.authProfileId : undefined,
      authProfileIdSource:
        params.provider === params.run.provider ? params.run.authProfileIdSource : undefined,
      model: params.model,
      provider: params.provider,
    },
    senderContext: {},
  }),
  resolveModelFallbackOptions: vi.fn(() => ({})),
  resolveQueuedReplyRuntimeConfig: <T>(config: T) => config,
}));

vi.mock("./reply-delivery.js", () => ({
  createBlockReplyDeliveryHandler: vi.fn(),
}));

vi.mock("./reply-media-paths.runtime.js", () => ({
  createReplyMediaPathNormalizer: () => (payload: unknown) => payload,
}));

async function getRunAgentTurnWithFallback() {
  return (await import("./agent-runner-execution.js")).runAgentTurnWithFallback;
}

async function getApplyFallbackCandidateSelectionToEntry() {
  return (await import("./agent-runner-execution.js")).applyFallbackCandidateSelectionToEntry;
}

interface FallbackRunnerParams {
  run: (provider: string, model: string) => Promise<unknown>;
}

interface EmbeddedAgentParams {
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onItemEvent?: (payload: {
    itemId?: string;
    kind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    progressText?: string;
    approvalId?: string;
    approvalSlug?: string;
  }) => Promise<void> | void;
  onAgentEvent?: (payload: {
    stream: string;
    data: Record<string, unknown>;
  }) => Promise<void> | void;
}

function createMockTypingSignaler(): TypingSignaler {
  return {
    mode: "message",
    shouldStartImmediately: false,
    shouldStartOnMessageStart: true,
    shouldStartOnReasoning: false,
    shouldStartOnText: true,
    signalMessageStart: vi.fn(async () => {}),
    signalReasoningDelta: vi.fn(async () => {}),
    signalRunStart: vi.fn(async () => {}),
    signalTextDelta: vi.fn(async () => {}),
    signalToolStart: vi.fn(async () => {}),
  };
}

function createFollowupRun(): FollowupRun {
  return {
    enqueuedAt: Date.now(),
    prompt: "hello",
    run: {
      agentDir: "/tmp/agent",
      agentId: "agent",
      bashElevated: {
        allowed: false,
        defaultLevel: "off",
        enabled: false,
      },
      blockReplyBreak: "message_end",
      config: {},
      elevatedLevel: "off",
      messageProvider: "whatsapp",
      model: "claude",
      provider: "anthropic",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session",
      sessionKey: "main",
      skillsSnapshot: {},
      thinkLevel: "low",
      timeoutMs: 1000,
      verboseLevel: "off",
      workspaceDir: "/tmp",
    },
    summaryLine: "hello",
  } as unknown as FollowupRun;
}

function createMockReplyOperation(): {
  replyOperation: ReplyOperation;
  failMock: ReturnType<typeof vi.fn>;
} {
  const failMock = vi.fn();
  return {
    failMock,
    replyOperation: {
      abortByUser: vi.fn(),
      abortForRestart: vi.fn(),
      abortSignal: new AbortController().signal,
      attachBackend: vi.fn(),
      complete: vi.fn(),
      detachBackend: vi.fn(),
      fail: failMock,
      key: "main",
      phase: "running",
      resetTriggered: false,
      result: null,
      sessionId: "session",
      setPhase: vi.fn(),
      updateSessionId: vi.fn(),
    },
  };
}

describe("runAgentTurnWithFallback", () => {
  beforeEach(() => {
    state.runEmbeddedPiAgentMock.mockReset();
    state.runWithModelFallbackMock.mockReset();
    state.isInternalMessageChannelMock.mockReset();
    state.isInternalMessageChannelMock.mockReturnValue(false);
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
      attempts: [],
      model: "claude",
      provider: "anthropic",
      result: await params.run("anthropic", "claude"),
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards media-only tool results without typing text", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onToolResult?.({ mediaUrls: ["/tmp/generated.png"] });
      return { meta: {}, payloads: [{ text: "final" }] };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const typingSignals = createMockTypingSignaler();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {
        onToolResult,
      } satisfies GetReplyOptions,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals,
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(typingSignals.signalTextDelta).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult.mock.calls[0]?.[0]).toMatchObject({
      mediaUrls: ["/tmp/generated.png"],
    });
    expect(onToolResult.mock.calls[0]?.[0]?.text).toBeUndefined();
  });

  it("strips a glued leading NO_REPLY token from streamed tool results", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onToolResult?.({ text: "NO_REPLYThe user is saying hello" });
      return { meta: {}, payloads: [{ text: "final" }] };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const typingSignals = createMockTypingSignaler();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {
        onToolResult,
      } satisfies GetReplyOptions,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals,
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("The user is saying hello");
    expect(onToolResult).toHaveBeenCalledWith({ text: "The user is saying hello" });
  });

  it("continues delivering later streamed tool results after an earlier delivery failure", async () => {
    const delivered: string[] = [];
    const onToolResult = vi.fn(async (payload: { text?: string }) => {
      if (payload.text === "first") {
        throw new Error("simulated delivery failure");
      }
      delivered.push(payload.text ?? "");
    });
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onToolResult?.({ mediaUrls: [], text: "first" });
      params.onToolResult?.({ mediaUrls: [], text: "second" });
      return { meta: {}, payloads: [{ text: "final" }] };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: { onToolResult } satisfies GetReplyOptions,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual(["second"]);
  });

  it("delivers streamed tool results in callback order even when dispatch latency differs", async () => {
    const deliveryOrder: string[] = [];
    const onToolResult = vi.fn(async (payload: { text?: string }) => {
      const delay = payload.text === "first" ? 5 : 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      deliveryOrder.push(payload.text ?? "");
    });
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onToolResult?.({ mediaUrls: [], text: "first" });
      params.onToolResult?.({ mediaUrls: [], text: "second" });
      return { meta: {}, payloads: [{ text: "final" }] };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: { onToolResult } satisfies GetReplyOptions,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(deliveryOrder).toEqual(["first", "second"]);
  });

  it("forwards item lifecycle events to reply options", async () => {
    const onItemEvent = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        data: {
          itemId: "tool:read-1",
          kind: "tool",
          name: "read",
          phase: "start",
          status: "running",
          title: "read",
        },
        stream: "item",
      });
      return { meta: {}, payloads: [{ text: "final" }] };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const typingSignals = createMockTypingSignaler();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {
        onItemEvent,
      } satisfies GetReplyOptions,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals,
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "tool:read-1",
      kind: "tool",
      name: "read",
      phase: "start",
      status: "running",
      title: "read",
    });
  });

  it("trims chatty GPT ack-turn final prose", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      attempts: [],
      model: "gpt-5.4",
      provider: "openai",
      result: await params.run("openai", "gpt-5.4"),
    }));
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
      meta: {},
      payloads: [
        {
          text: [
            "I updated the prompt overlay and tightened the runtime guard.",
            "I also added the ack-turn fast path so short approvals skip the recap.",
            "The reply-side brevity cap now trims long prose-heavy GPT confirmations.",
            "I updated tests for the overlay, retry guard, and reply normalization.",
            "Everything is wired together and ready for verification.",
          ].join(" "),
        },
      ],
    }));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "ok do it",
      followupRun,
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads?.[0]?.text).toBe(
        "I updated the prompt overlay and tightened the runtime guard. I also added the ack-turn fast path so short approvals skip the recap. The reply-side brevity cap now trims long prose-heavy GPT confirmations...",
      );
    }
  });

  it("does not trim GPT replies when the user asked for depth", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      attempts: [],
      model: "gpt-5.4",
      provider: "openai",
      result: await params.run("openai", "gpt-5.4"),
    }));
    const longDetailedReply = [
      "Here is the detailed breakdown.",
      "First, the runner now detects short approval turns and skips the recap path.",
      "Second, the reply layer scores long prose-heavy GPT confirmations and trims them only in chat-style turns.",
      "Third, code fences and richer structured outputs are left untouched so technical answers stay intact.",
      "Finally, the overlay reinforces that this is a live chat and nudges the model toward short natural replies.",
    ].join(" ");
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
      meta: {},
      payloads: [{ text: longDetailedReply }],
    }));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "explain in detail what changed",
      followupRun,
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads?.[0]?.text).toBe(longDetailedReply);
    }
  });

  it("forwards plan, approval, command output, and patch events", async () => {
    const onPlanUpdate = vi.fn();
    const onApprovalEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onPatchSummary = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        data: {
          explanation: "Inspect code, patch it, run tests.",
          phase: "update",
          steps: ["Inspect code", "Patch code", "Run tests"],
          title: "Assistant proposed a plan",
        },
        stream: "plan",
      });
      await params.onAgentEvent?.({
        data: {
          approvalId: "approval-1",
          kind: "exec",
          phase: "requested",
          status: "pending",
          title: "Command approval requested",
        },
        stream: "approval",
      });
      await params.onAgentEvent?.({
        data: {
          itemId: "command:exec-1",
          output: "README.md",
          phase: "delta",
          title: "command ls",
          toolCallId: "exec-1",
        },
        stream: "command_output",
      });
      await params.onAgentEvent?.({
        data: {
          added: ["a.ts"],
          deleted: [],
          itemId: "patch:patch-1",
          modified: ["b.ts"],
          phase: "end",
          summary: "1 added, 1 modified",
          title: "apply patch",
          toolCallId: "patch-1",
        },
        stream: "patch",
      });
      return { meta: {}, payloads: [{ text: "final" }] };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {
        onApprovalEvent,
        onCommandOutput,
        onPatchSummary,
        onPlanUpdate,
      } satisfies GetReplyOptions,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(onPlanUpdate).toHaveBeenCalledWith({
      explanation: "Inspect code, patch it, run tests.",
      phase: "update",
      source: undefined,
      steps: ["Inspect code", "Patch code", "Run tests"],
      title: "Assistant proposed a plan",
    });
    expect(onApprovalEvent).toHaveBeenCalledWith({
      approvalId: "approval-1",
      approvalSlug: undefined,
      command: undefined,
      host: undefined,
      itemId: undefined,
      kind: "exec",
      message: undefined,
      phase: "requested",
      reason: undefined,
      status: "pending",
      title: "Command approval requested",
      toolCallId: undefined,
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      cwd: undefined,
      durationMs: undefined,
      exitCode: undefined,
      itemId: "command:exec-1",
      name: undefined,
      output: "README.md",
      phase: "delta",
      status: undefined,
      title: "command ls",
      toolCallId: "exec-1",
    });
    expect(onPatchSummary).toHaveBeenCalledWith({
      added: ["a.ts"],
      deleted: [],
      itemId: "patch:patch-1",
      modified: ["b.ts"],
      name: undefined,
      phase: "end",
      summary: "1 added, 1 modified",
      title: "apply patch",
      toolCallId: "patch-1",
    });
  });

  it("keeps compaction start notices silent by default", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ data: { phase: "start" }, stream: "compaction" });
      return { meta: {}, payloads: [{ text: "final" }] };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: { onBlockReply },
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("success");
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("keeps compaction callbacks active when notices are silent by default", async () => {
    const onBlockReply = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ data: { phase: "start" }, stream: "compaction" });
      await params.onAgentEvent?.({
        data: { completed: true, phase: "end" },
        stream: "compaction",
      });
      return { meta: {}, payloads: [{ text: "final" }] };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {
        onBlockReply,
        onCompactionEnd,
        onCompactionStart,
      },
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("success");
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("emits a compaction start notice when notifyUser is enabled", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ data: { phase: "start" }, stream: "compaction" });
      return { meta: {}, payloads: [{ text: "final" }] };
    });

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          compaction: {
            notifyUser: true,
          },
        },
      },
    };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun,
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: { onBlockReply },
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("success");
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        isCompactionNotice: true,
        replyToCurrent: true,
        replyToId: "msg",
        text: "🧹 Compacting context...",
      }),
    );
  });

  it("does not show a rate-limit countdown for mixed-cause fallback exhaustion", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "All models failed (2): anthropic/claude: 429 (rate_limit) | openai/gpt-5.4: 402 (billing)",
        ),
        {
          attempts: [
            { error: "429", model: "claude", provider: "anthropic", reason: "rate_limit" },
            { error: "402", model: "gpt-5.4", provider: "openai", reason: "billing" },
          ],
          name: "FallbackSummaryError",
          soonestCooldownExpiry: Date.now() + 60_000,
        },
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Something went wrong while processing your request");
      expect(result.payload.text).not.toContain("Rate-limited");
    }
  });

  it("surfaces gateway restart text when fallback exhaustion wraps a drain error", async () => {
    const { replyOperation, failMock } = createMockReplyOperation();
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error("fallback exhausted"), {
        attempts: [
          {
            error: new GatewayDrainingError(),
            model: "claude",
            provider: "anthropic",
          },
        ],
        cause: new GatewayDrainingError(),
        name: "FallbackSummaryError",
        soonestCooldownExpiry: null,
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      replyOperation,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    }
    expect(failMock).toHaveBeenCalledWith("gateway_draining", expect.any(GatewayDrainingError));
  });

  it("surfaces gateway restart text when fallback exhaustion wraps a cleared lane error", async () => {
    const { replyOperation, failMock } = createMockReplyOperation();
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error("fallback exhausted"), {
        attempts: [
          {
            error: new CommandLaneClearedError("session:main"),
            model: "claude",
            provider: "anthropic",
          },
        ],
        cause: new CommandLaneClearedError("session:main"),
        name: "FallbackSummaryError",
        soonestCooldownExpiry: null,
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      replyOperation,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    }
    expect(failMock).toHaveBeenCalledWith(
      "command_lane_cleared",
      expect.any(CommandLaneClearedError),
    );
  });

  it("surfaces gateway restart text when the reply operation was aborted for restart", async () => {
    const { replyOperation, failMock } = createMockReplyOperation();
    Object.defineProperty(replyOperation, "result", {
      configurable: true,
      value: { code: "aborted_for_restart", kind: "aborted" } as const,
    });
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      replyOperation,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    }
    expect(failMock).not.toHaveBeenCalled();
  });

  it("returns a friendly generic error on external chat channels", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("INVALID_ARGUMENT: some other failure"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      );
    }
  });

  it("surfaces gateway reauth guidance for known OAuth refresh failures", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error(
        "OAuth token refresh failed for openai-codex: refresh_token_reused. Please try again or re-authenticate.",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway for openai-codex. Re-auth with `openclaw models auth login --provider openai-codex`, then try again.",
      );
    }
  });

  it("surfaces direct provider auth guidance for missing API keys", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error(
        'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4. | No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.',
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Missing API key for OpenAI on the gateway. Use `openai-codex/gpt-5.4` for OAuth, or set `OPENAI_API_KEY`, then try again.",
      );
    }
  });

  it("falls back to a generic provider message for unsafe missing-key provider ids", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error('No API key found for provider "openai`\nrm -rf /".'),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.",
      );
    }
  });

  it("falls back to a generic reauth command when the provider in the OAuth error is unsafe", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error(
        "OAuth token refresh failed for openai-codex`\nrm -rf /: invalid_grant. Please try again or re-authenticate.",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway. Re-auth with `openclaw models auth login`, then try again.",
      );
    }
  });

  it("returns a session reset hint for Bedrock tool mismatch errors on external chat channels", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error(
        "The number of toolResult blocks at messages.186.content exceeds the number of toolUse blocks of previous turn.",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Session history got out of sync. Please try again, or use /new to start a fresh session.",
      );
    }
  });

  it("keeps raw generic errors on internal control surfaces", async () => {
    state.isInternalMessageChannelMock.mockReturnValue(true);
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("INVALID_ARGUMENT: some other failure"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "chat",
        Surface: "chat",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Agent failed before reply");
      expect(result.payload.text).toContain("INVALID_ARGUMENT: some other failure");
      expect(result.payload.text).toContain("Logs: openclaw logs --follow");
    }
  });

  it("restarts the active prompt when a live model switch is requested", async () => {
    let fallbackInvocation = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        attempts: [],
        model: fallbackInvocation++ === 0 ? "claude" : "gpt-5.4",
        provider: fallbackInvocation === 0 ? "anthropic" : "openai",
        result: await params.run(
          fallbackInvocation === 0 ? "anthropic" : "openai",
          fallbackInvocation === 0 ? "claude" : "gpt-5.4",
        ),
      }),
    );
    state.runEmbeddedPiAgentMock
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          model: "gpt-5.4",
          provider: "openai",
        });
      })
      .mockImplementationOnce(async () => ({
        meta: {
          agentMeta: {
            model: "gpt-5.4",
            provider: "openai",
            sessionId: "session",
          },
        },
        payloads: [{ text: "switched" }],
      }));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun,
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("success");
    expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.4");
  });

  it("breaks out of the retry loop when LiveSessionModelSwitchError is thrown repeatedly (#58348)", async () => {
    // Simulate a scenario where the persisted session selection keeps conflicting
    // With the fallback model, causing LiveSessionModelSwitchError on every attempt.
    // The outer loop must be bounded to prevent a session death loop.
    let switchCallCount = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        switchCallCount++;
        return {
          attempts: [],
          model: "claude",
          provider: "anthropic",
          result: await params.run("anthropic", "claude"),
        };
      },
    );
    state.runEmbeddedPiAgentMock.mockImplementation(async () => {
      throw new LiveSessionModelSwitchError({
        model: "gpt-5.4",
        provider: "openai",
      });
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun,
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    // After MAX_LIVE_SWITCH_RETRIES (2) the loop must break instead of continuing
    // Forever. The result should be a final error, not an infinite hang.
    expect(result.kind).toBe("final");
    // 1 initial + MAX_LIVE_SWITCH_RETRIES retries = exact total invocations
    expect(switchCallCount).toBe(1 + MAX_LIVE_SWITCH_RETRIES);
  });

  it("propagates auth profile state on bounded live model switch retries (#58348)", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        invocation++;
        if (invocation <= 2) {
          return {
            attempts: [],
            model: "claude",
            provider: "anthropic",
            result: await params.run("anthropic", "claude"),
          };
        }
        // Third invocation succeeds with the switched model
        return {
          attempts: [],
          model: "gpt-5.4",
          provider: "openai",
          result: await params.run("openai", "gpt-5.4"),
        };
      },
    );
    state.runEmbeddedPiAgentMock
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          authProfileId: "profile-b",
          authProfileIdSource: "user",
          model: "gpt-5.4",
          provider: "openai",
        });
      })
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          authProfileId: "profile-c",
          authProfileIdSource: "auto",
          model: "gpt-5.4",
          provider: "openai",
        });
      })
      .mockImplementationOnce(async () => ({
        meta: {
          agentMeta: {
            model: "gpt-5.4",
            provider: "openai",
            sessionId: "session",
          },
        },
        payloads: [{ text: "finally ok" }],
      }));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    const result = await runAgentTurnWithFallback({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun,
      getActiveSessionEntry: () => undefined,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    // Two switches (within the limit of 2) then success on third attempt
    expect(result.kind).toBe("success");
    expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(3);
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.4");
    expect(followupRun.run.authProfileId).toBe("profile-c");
    expect(followupRun.run.authProfileIdSource).toBe("auto");
  });

  it("does not roll back newer override changes after a failed fallback candidate", async () => {
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        await expect(params.run("openai", "gpt-5.4")).rejects.toThrow("fallback failed");
        throw new Error("fallback failed");
      },
    );
    const sessionEntry: SessionEntry = {
      authProfileOverride: "anthropic:default",
      authProfileOverrideSource: "user",
      modelOverride: "claude",
      providerOverride: "anthropic",
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore = { main: sessionEntry };
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      sessionEntry.providerOverride = "zai";
      sessionEntry.modelOverride = "glm-5";
      sessionEntry.authProfileOverride = "zai:work";
      sessionEntry.authProfileOverrideSource = "user";
      throw new Error("fallback failed");
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      activeSessionStore: sessionStore,
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun: createFollowupRun(),
      getActiveSessionEntry: () => sessionEntry,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "whatsapp",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("final");
    expect(sessionEntry.providerOverride).toBe("zai");
    expect(sessionEntry.modelOverride).toBe("glm-5");
    expect(sessionEntry.authProfileOverride).toBe("zai:work");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(sessionStore.main.providerOverride).toBe("zai");
    expect(sessionStore.main.modelOverride).toBe("glm-5");
  });

  it("drops authProfileId when fallback switches providers", async () => {
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        attempts: [],
        model: "gpt-5.4",
        provider: "openai-codex",
        result: await params.run("openai-codex", "gpt-5.4"),
      }),
    );
    state.runEmbeddedPiAgentMock.mockResolvedValue({
      meta: {},
      payloads: [{ text: "ok" }],
    });

    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus";
    followupRun.run.authProfileId = "anthropic:openclaw";
    followupRun.run.authProfileIdSource = "user";

    const sessionEntry: SessionEntry = {
      compactionCount: 0,
      sessionId: "session",
      totalTokens: 1,
      updatedAt: Date.now(),
    };
    const sessionStore = { main: sessionEntry };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      activeSessionStore: sessionStore,
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      commandBody: "hello",
      followupRun,
      getActiveSessionEntry: () => sessionEntry,
      isHeartbeat: false,
      opts: {},
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      sessionCtx: {
        MessageSid: "msg",
        Provider: "telegram",
      } as unknown as TemplateContext,
      sessionKey: "main",
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => true,
      typingSignals: createMockTypingSignaler(),
    });

    expect(result.kind).toBe("success");
    expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(state.runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      authProfileId: undefined,
      authProfileIdSource: undefined,
      model: "gpt-5.4",
      provider: "openai-codex",
    });
    expect(sessionEntry.providerOverride).toBe("openai-codex");
    expect(sessionEntry.modelOverride).toBe("gpt-5.4");
    expect(sessionEntry.modelOverrideSource).toBe("auto");
    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionStore.main.authProfileOverride).toBeUndefined();
  });

  it("keeps same-provider auth profile when fallback only changes model", async () => {
    const applyFallbackCandidateSelectionToEntry =
      await getApplyFallbackCandidateSelectionToEntry();
    const entry = {
      authProfileOverride: "anthropic:openclaw",
      authProfileOverrideSource: "user" as const,
      sessionId: "session",
      updatedAt: 1,
    } as SessionEntry;

    const { updated } = applyFallbackCandidateSelectionToEntry({
      entry,
      model: "claude-sonnet",
      now: 123,
      provider: "anthropic",
      run: {
        authProfileId: "anthropic:openclaw",
        authProfileIdSource: "user",
        model: "claude-opus",
        provider: "anthropic",
      } as FollowupRun["run"],
    });

    expect(updated).toBe(true);
    expect(entry).toMatchObject({
      authProfileOverride: "anthropic:openclaw",
      authProfileOverrideSource: "user",
      modelOverride: "claude-sonnet",
      modelOverrideSource: "auto",
      providerOverride: "anthropic",
      updatedAt: 123,
    });
  });
});
