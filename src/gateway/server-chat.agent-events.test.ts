import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";

const persistGatewaySessionLifecycleEventMock = vi.fn();

vi.mock("./server-chat.persist-session-lifecycle.runtime.js", () => ({
  persistGatewaySessionLifecycleEvent: (...args: unknown[]) =>
    persistGatewaySessionLifecycleEventMock(...args),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: vi.fn(() => ({
    showAlerts: true,
    showOk: false,
    useIndicator: true,
  })),
}));

vi.mock("./server-chat.load-gateway-session-row.runtime.js", () => ({
  loadGatewaySessionRow: vi.fn(),
}));

import { loadConfig } from "../config/config.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { loadGatewaySessionRow } from "./server-chat.load-gateway-session-row.runtime.js";

describe("agent event handler", () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockReturnValue({});
    vi.mocked(resolveHeartbeatVisibility).mockReturnValue({
      showAlerts: true,
      showOk: false,
      useIndicator: true,
    });
    vi.mocked(loadGatewaySessionRow).mockReset().mockReturnValue(null);
    persistGatewaySessionLifecycleEventMock.mockReset().mockResolvedValue(undefined);
    resetAgentRunContextForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAgentRunContextForTest();
  });

  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
    lifecycleErrorRetryGraceMs?: number;
    isChatSendRunActive?: (runId: string) => boolean;
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const clearAgentRunContext = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();

    const handler = createAgentEventHandler({
      agentRunSeq,
      broadcast,
      broadcastToConnIds,
      chatRunState,
      clearAgentRunContext,
      isChatSendRunActive: params?.isChatSendRunActive,
      lifecycleErrorRetryGraceMs: params?.lifecycleErrorRetryGraceMs,
      nodeSendToSession,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      sessionEventSubscribers,
      toolEventRecipients,
    });

    return {
      agentRunSeq,
      broadcast,
      broadcastToConnIds,
      chatRunState,
      clearAgentRunContext,
      handler,
      nodeSendToSession,
      nowSpy,
      sessionEventSubscribers,
      toolEventRecipients,
    };
  }

  function emitRun1AssistantText(
    harness: ReturnType<typeof createHarness>,
    text: string,
  ): ReturnType<typeof createHarness> {
    harness.chatRunState.registry.add("run-1", {
      clientRunId: "client-1",
      sessionKey: "session-1",
    });
    harness.handler({
      data: { text },
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });
    return harness;
  }

  function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "chat");
  }

  function sessionChatCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
  }

  const FALLBACK_LIFECYCLE_DATA = {
    activeModel: "moonshotai/Kimi-K2.5",
    activeProvider: "deepinfra",
    phase: "fallback",
    selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
    selectedProvider: "fireworks",
  } as const;

  function emitLifecycleEnd(
    handler: ReturnType<typeof createHarness>["handler"],
    runId: string,
    seq = 2,
  ) {
    handler({
      data: { phase: "end" },
      runId,
      seq,
      stream: "lifecycle",
      ts: Date.now(),
    });
  }

  function emitFallbackLifecycle(params: {
    handler: ReturnType<typeof createHarness>["handler"];
    runId: string;
    seq?: number;
    sessionKey?: string;
  }) {
    params.handler({
      runId: params.runId,
      seq: params.seq ?? 1,
      stream: "lifecycle",
      ts: Date.now(),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      data: { ...FALLBACK_LIFECYCLE_DATA },
    });
  }

  function expectSingleAgentBroadcastPayload(broadcast: ReturnType<typeof vi.fn>) {
    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    return broadcastAgentCalls[0]?.[1] as {
      runId?: string;
      sessionKey?: string;
      stream?: string;
      data?: Record<string, unknown>;
    };
  }

  function expectSingleFinalChatPayload(broadcast: ReturnType<typeof vi.fn>) {
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: unknown;
    };
    expect(payload.state).toBe("final");
    return payload;
  }

  it("emits chat delta for assistant text-only events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1000 }),
      "Hello world",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: { text?: string }[] };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("strips inline directives from assistant chat events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1000 }),
      "Hello [[reply_to_current]] world [[audio_as_voice]]",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      message?: { content?: { text?: string }[] };
    };
    expect(payload.message?.content?.[0]?.text).toBe("Hello  world ");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it.each([" NO_REPLY  ", " ANNOUNCE_SKIP ", " REPLY_SKIP "])(
    "does not emit chat delta for suppressed control text %s",
    (replyText) => {
      const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
        createHarness({ now: 1000 }),
        replyText,
      );
      expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
      expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);
      nowSpy?.mockRestore();
    },
  );

  it.each(["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "does not include %s text in chat final message",
    (replyText) => {
      const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
        now: 2000,
      });
      chatRunState.registry.add("run-2", { clientRunId: "client-2", sessionKey: "session-2" });

      handler({
        data: { text: replyText },
        runId: "run-2",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
      });
      emitLifecycleEnd(handler, "run-2");

      const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
      expect(payload.message).toBeUndefined();
      expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
      nowSpy?.mockRestore();
    },
  );

  it("suppresses NO_REPLY lead fragments and does not leak NO in final chat message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2100,
    });
    chatRunState.registry.add("run-3", { clientRunId: "client-3", sessionKey: "session-3" });

    for (const text of ["NO", "NO_", "NO_RE", "NO_REPLY"]) {
      handler({
        data: { text },
        runId: "run-3",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
      });
    }
    emitLifecycleEnd(handler, "run-3");

    const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(payload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it.each([
    ["ANNOUNCE_SKIP", ["ANN", "ANNOUNCE_", "ANNOUNCE_SKIP"]],
    ["REPLY_SKIP", ["REP", "REPLY_", "REPLY_SKIP"]],
  ] as const)(
    "suppresses %s lead fragments and does not leak the streamed prefix in the final chat message",
    (_replyText, fragments) => {
      const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
        now: 2150,
      });
      chatRunState.registry.add("run-control", {
        clientRunId: "client-control",
        sessionKey: "session-control",
      });

      for (const text of fragments) {
        handler({
          data: { text },
          runId: "run-control",
          seq: 1,
          stream: "assistant",
          ts: Date.now(),
        });
      }
      emitLifecycleEnd(handler, "run-control");

      const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
      expect(payload.message).toBeUndefined();
      expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
      nowSpy?.mockRestore();
    },
  );

  it("keeps final short replies like 'No' even when lead-fragment deltas are suppressed", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2200,
    });
    chatRunState.registry.add("run-4", { clientRunId: "client-4", sessionKey: "session-4" });

    handler({
      data: { text: "No" },
      runId: "run-4",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });
    emitLifecycleEnd(handler, "run-4");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: { content?: { text?: string }[] };
    };
    expect(payload.message?.content?.[0]?.text).toBe("No");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("strips a glued leading NO_REPLY token from cumulative chat snapshots", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2250,
    });
    chatRunState.registry.add("run-4b", { clientRunId: "client-4b", sessionKey: "session-4b" });

    handler({
      data: { text: "NO_REPLYThe user" },
      runId: "run-4b",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });
    handler({
      data: { text: "NO_REPLYThe user is saying hello" },
      runId: "run-4b",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
    });
    emitLifecycleEnd(handler, "run-4b");

    const chatCalls = chatBroadcastCalls(broadcast);
    const finalPayload = chatCalls.at(-1)?.[1] as {
      message?: { content?: { text?: string }[] };
      state?: string;
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("The user is saying hello");
    expect(
      chatCalls.every(([, payload]) => {
        const text = (payload as { message?: { content?: { text?: string }[] } }).message
          ?.content?.[0]?.text;
        return !text || !text.includes("NO_REPLY");
      }),
    ).toBe(true);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(chatCalls.length);
    nowSpy?.mockRestore();
  });

  it("flushes buffered text as delta before final when throttle suppresses the latest chunk", () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-flush", {
      clientRunId: "client-flush",
      sessionKey: "session-flush",
    });

    handler({
      data: { text: "Hello" },
      runId: "run-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });

    now = 10_100;
    handler({
      data: { text: "Hello world" },
      runId: "run-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });

    emitLifecycleEnd(handler, "run-flush");

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const firstPayload = chatCalls[0]?.[1] as { state?: string };
    const secondPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: { text?: string }[] };
    };
    const thirdPayload = chatCalls[2]?.[1] as { state?: string };
    expect(firstPayload.state).toBe("delta");
    expect(secondPayload.state).toBe("delta");
    expect(secondPayload.message?.content?.[0]?.text).toBe("Hello world");
    expect(thirdPayload.state).toBe("final");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("preserves pre-tool assistant text when later segments stream as non-prefix snapshots", () => {
    let now = 10_500;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-segmented", {
      clientRunId: "client-segmented",
      sessionKey: "session-segmented",
    });

    handler({
      data: { delta: "Before tool call", text: "Before tool call" },
      runId: "run-segmented",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });

    now = 10_700;
    handler({
      data: { delta: "\nAfter tool call", text: "After tool call" },
      runId: "run-segmented",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
    });

    emitLifecycleEnd(handler, "run-segmented", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const secondPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: { text?: string }[] };
    };
    const finalPayload = chatCalls[2]?.[1] as {
      state?: string;
      message?: { content?: { text?: string }[] };
    };
    expect(secondPayload.state).toBe("delta");
    expect(secondPayload.message?.content?.[0]?.text).toBe("Before tool call\nAfter tool call");
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Before tool call\nAfter tool call");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("flushes merged segmented text before final when latest segment is throttled", () => {
    let now = 10_800;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-segmented-flush", {
      clientRunId: "client-segmented-flush",
      sessionKey: "session-segmented-flush",
    });

    handler({
      data: { delta: "Before tool call", text: "Before tool call" },
      runId: "run-segmented-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });

    now = 10_860;
    handler({
      data: { delta: "\nAfter tool call", text: "After tool call" },
      runId: "run-segmented-flush",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
    });

    emitLifecycleEnd(handler, "run-segmented-flush", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const flushPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: { text?: string }[] };
    };
    const finalPayload = chatCalls[2]?.[1] as {
      state?: string;
      message?: { content?: { text?: string }[] };
    };
    expect(flushPayload.state).toBe("delta");
    expect(flushPayload.message?.content?.[0]?.text).toBe("Before tool call\nAfter tool call");
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Before tool call\nAfter tool call");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("does not flush an extra delta when the latest text already broadcast", () => {
    let now = 11_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-no-dup-flush", {
      clientRunId: "client-no-dup-flush",
      sessionKey: "session-no-dup-flush",
    });

    handler({
      data: { text: "Hello" },
      runId: "run-no-dup-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });

    now = 11_200;
    handler({
      data: { text: "Hello world" },
      runId: "run-no-dup-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });

    emitLifecycleEnd(handler, "run-no-dup-flush");

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    expect(chatCalls.map(([, payload]) => (payload as { state?: string }).state)).toEqual([
      "delta",
      "delta",
      "final",
    ]);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("cleans up agent run sequence tracking when lifecycle completes", () => {
    const { agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 2500 });
    chatRunState.registry.add("run-cleanup", {
      clientRunId: "client-cleanup",
      sessionKey: "session-cleanup",
    });

    handler({
      data: { text: "done" },
      runId: "run-cleanup",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });
    expect(agentRunSeq.get("run-cleanup")).toBe(1);

    handler({
      data: { phase: "end" },
      runId: "run-cleanup",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
    });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("drops stale events that arrive after lifecycle completion", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2500,
    });
    chatRunState.registry.add("run-stale-tail", {
      clientRunId: "client-stale-tail",
      sessionKey: "session-stale-tail",
    });

    handler({
      data: { text: "done" },
      runId: "run-stale-tail",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });
    emitLifecycleEnd(handler, "run-stale-tail");
    const errorCallsBeforeStaleEvent = broadcast.mock.calls.filter(
      ([event, payload]) =>
        event === "agent" && (payload as { stream?: string }).stream === "error",
    ).length;
    const sessionChatCallsBeforeStaleEvent = sessionChatCalls(nodeSendToSession).length;

    handler({
      data: { text: "late tail" },
      runId: "run-stale-tail",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
    });

    const errorCalls = broadcast.mock.calls.filter(
      ([event, payload]) =>
        event === "agent" && (payload as { stream?: string }).stream === "error",
    );
    expect(errorCalls).toHaveLength(errorCallsBeforeStaleEvent);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(sessionChatCallsBeforeStaleEvent);
    nowSpy?.mockRestore();
  });

  it("flushes buffered chat delta before tool start events", () => {
    let now = 12_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const {
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      chatRunState,
      toolEventRecipients,
      handler,
    } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-flush",
    });

    chatRunState.registry.add("run-tool-flush", {
      clientRunId: "client-tool-flush",
      sessionKey: "session-tool-flush",
    });
    registerAgentRunContext("run-tool-flush", {
      sessionKey: "session-tool-flush",
      verboseLevel: "off",
    });
    toolEventRecipients.add("run-tool-flush", "conn-1");

    handler({
      data: { text: "Before tool" },
      runId: "run-tool-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });

    // Throttled assistant update (within 150ms window).
    now = 12_050;
    handler({
      data: { text: "Before tool expanded" },
      runId: "run-tool-flush",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
    });

    handler({
      data: { name: "read", phase: "start", toolCallId: "tool-flush-1" },
      runId: "run-tool-flush",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
    });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const flushedPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: { text?: string }[] };
    };
    expect(flushedPayload.state).toBe("delta");
    expect(flushedPayload.message?.content?.[0]?.text).toBe("Before tool expanded");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(2);

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const flushCallOrder = broadcast.mock.invocationCallOrder[1] ?? 0;
    const toolCallOrder = broadcastToConnIds.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(flushCallOrder).toBeLessThan(toolCallOrder);
    nowSpy.mockRestore();
    resetAgentRunContextForTest();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const { broadcast, broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

    handler({
      data: { name: "read", phase: "start", toolCallId: "t1" },
      runId: "run-tool",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    resetAgentRunContextForTest();
  });

  it("broadcasts tool events to WS recipients even when verbose is off, but skips node send", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    handler({
      data: { name: "read", phase: "start", toolCallId: "t2" },
      runId: "run-tool-off",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
    });

    // Tool events always broadcast to registered WS recipients
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    // But node/channel subscribers should NOT receive when verbose is off
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
    resetAgentRunContextForTest();
  });

  it("mirrors tool events to session subscribers so late-joining operator UIs can render them", () => {
    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      fastMode: true,
      forkedFromParent: true,
      key: "session-1",
      kind: "direct",
      lastThreadId: 42,
      spawnDepth: 2,
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      subagentControlScope: "children",
      subagentRole: "orchestrator",
      updatedAt: 1200,
      verboseLevel: "on",
    });

    registerAgentRunContext("run-session-tool", { sessionKey: "session-1", verboseLevel: "off" });
    sessionEventSubscribers.subscribe("conn-session");

    handler({
      data: {
        args: { command: "echo hi" },
        name: "exec",
        phase: "start",
        toolCallId: "tool-session-1",
      },
      runId: "run-session-tool",
      seq: 1,
      stream: "tool",
      ts: 1234,
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.tool",
      expect.objectContaining({
        data: expect.objectContaining({
          args: { command: "echo hi" },
          name: "exec",
          phase: "start",
          toolCallId: "tool-session-1",
        }),
        fastMode: true,
        forkedFromParent: true,
        lastThreadId: 42,
        runId: "run-session-tool",
        sessionKey: "session-1",
        spawnDepth: 2,
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent",
        stream: "tool",
        subagentControlScope: "children",
        subagentRole: "orchestrator",
        ts: 1234,
        verboseLevel: "on",
      }),
      new Set(["conn-session"]),
      { dropIfSlow: true },
    );
    resetAgentRunContextForTest();
  });

  it("hydrates run-scoped tool events with session ownership metadata", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      fastMode: true,
      forkedFromParent: true,
      key: "session-1",
      kind: "direct",
      lastThreadId: 42,
      spawnDepth: 2,
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      subagentControlScope: "children",
      subagentRole: "orchestrator",
      updatedAt: 1200,
      verboseLevel: "on",
    });

    registerAgentRunContext("run-tool-owner", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-owner", "conn-run");

    handler({
      data: {
        args: { command: "echo hi" },
        name: "exec",
        phase: "start",
        toolCallId: "tool-run-1",
      },
      runId: "run-tool-owner",
      seq: 1,
      stream: "tool",
      ts: 1234,
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
        data: expect.objectContaining({
          args: { command: "echo hi" },
          name: "exec",
          phase: "start",
          toolCallId: "tool-run-1",
        }),
        fastMode: true,
        forkedFromParent: true,
        lastThreadId: 42,
        runId: "run-tool-owner",
        sessionKey: "session-1",
        spawnDepth: 2,
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent",
        stream: "tool",
        subagentControlScope: "children",
        subagentRole: "orchestrator",
        ts: 1234,
        verboseLevel: "on",
      }),
      new Set(["conn-run"]),
    );
    resetAgentRunContextForTest();
  });

  it("hydrates node session tool events with session ownership metadata", () => {
    const { nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      fastMode: true,
      forkedFromParent: true,
      key: "session-1",
      kind: "direct",
      lastThreadId: 42,
      spawnDepth: 2,
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      subagentControlScope: "children",
      subagentRole: "orchestrator",
      updatedAt: 1200,
      verboseLevel: "on",
    });

    registerAgentRunContext("run-tool-node", { sessionKey: "session-1", verboseLevel: "on" });

    handler({
      data: {
        args: { command: "echo hi" },
        name: "exec",
        phase: "start",
        toolCallId: "tool-node-1",
      },
      runId: "run-tool-node",
      seq: 1,
      stream: "tool",
      ts: 1234,
    });

    expect(nodeSendToSession).toHaveBeenCalledWith(
      "session-1",
      "agent",
      expect.objectContaining({
        data: expect.objectContaining({
          args: { command: "echo hi" },
          name: "exec",
          phase: "start",
          toolCallId: "tool-node-1",
        }),
        fastMode: true,
        forkedFromParent: true,
        lastThreadId: 42,
        runId: "run-tool-node",
        sessionKey: "session-1",
        spawnDepth: 2,
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent",
        stream: "tool",
        subagentControlScope: "children",
        subagentRole: "orchestrator",
        ts: 1234,
        verboseLevel: "on",
      }),
    );
    resetAgentRunContextForTest();
  });

  it("broadcasts terminal session status to session subscribers on lifecycle end", () => {
    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-finished",
    });

    sessionEventSubscribers.subscribe("conn-session");
    registerAgentRunContext("run-finished", {
      sessionKey: "session-finished",
      verboseLevel: "off",
    });

    handler({
      data: {
        phase: "start",
        startedAt: 900,
      },
      runId: "run-finished",
      seq: 1,
      stream: "lifecycle",
      ts: 1000,
    });
    handler({
      data: {
        endedAt: 1700,
        phase: "end",
        startedAt: 900,
      },
      runId: "run-finished",
      seq: 2,
      stream: "lifecycle",
      ts: 1800,
    });

    const sessionsChangedCalls = broadcastToConnIds.mock.calls.filter(
      ([event]) => event === "sessions.changed",
    );
    expect(sessionsChangedCalls).toHaveLength(2);
    expect(sessionsChangedCalls[1]?.[1]).toEqual(
      expect.objectContaining({
        abortedLastRun: false,
        endedAt: 1700,
        phase: "end",
        runtimeMs: 800,
        sessionKey: "session-finished",
        startedAt: 900,
        status: "done",
        updatedAt: 1700,
      }),
    );
    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledWith({
      event: expect.objectContaining({
        data: expect.objectContaining({ phase: "end" }),
        runId: "run-finished",
      }),
      sessionKey: "session-finished",
    });
    resetAgentRunContextForTest();
  });

  it("keeps live session setting metadata at the top level for lifecycle updates", () => {
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      abortedLastRun: false,
      contextTokens: 21,
      estimatedCostUsd: 0.12,
      fastMode: true,
      forkedFromParent: true,
      key: "session-finished",
      kind: "direct",
      lastThreadId: 42,
      responseUsage: "full",
      runtimeMs: 750,
      sendPolicy: "deny",
      spawnDepth: 2,
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      startedAt: 900,
      status: "running",
      subagentControlScope: "children",
      subagentRole: "orchestrator",
      totalTokens: 42,
      totalTokensFresh: true,
      updatedAt: 1650,
      verboseLevel: "on",
    });

    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-finished",
    });

    sessionEventSubscribers.subscribe("conn-session");
    registerAgentRunContext("run-finished", {
      sessionKey: "session-finished",
      verboseLevel: "off",
    });

    handler({
      data: {
        endedAt: 1700,
        phase: "end",
        startedAt: 900,
      },
      runId: "run-finished",
      seq: 2,
      stream: "lifecycle",
      ts: 1800,
    });

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        contextTokens: 21,
        estimatedCostUsd: 0.12,
        fastMode: true,
        forkedFromParent: true,
        lastThreadId: 42,
        phase: "end",
        responseUsage: "full",
        sendPolicy: "deny",
        sessionKey: "session-finished",
        spawnDepth: 2,
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent",
        subagentControlScope: "children",
        subagentRole: "orchestrator",
        totalTokens: 42,
        totalTokensFresh: true,
        verboseLevel: "on",
      }),
      new Set(["conn-session"]),
      { dropIfSlow: true },
    );
  });

  it("strips tool output when verbose is on", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-on", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on", "conn-1");

    handler({
      data: {
        name: "exec",
        partialResult: { content: [{ text: "partial", type: "text" }] },
        phase: "result",
        result: { content: [{ text: "secret", type: "text" }] },
        toolCallId: "t3",
      },
      runId: "run-tool-on",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toBeUndefined();
    expect(payload.data?.partialResult).toBeUndefined();
    resetAgentRunContextForTest();
  });

  it("keeps tool output when verbose is full", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-full", { sessionKey: "session-1", verboseLevel: "full" });
    toolEventRecipients.add("run-tool-full", "conn-1");

    const result = { content: [{ text: "secret", type: "text" }] };
    handler({
      data: {
        name: "exec",
        phase: "result",
        result,
        toolCallId: "t4",
      },
      runId: "run-tool-full",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toEqual(result);
    resetAgentRunContextForTest();
  });

  it("broadcasts fallback events to agent subscribers and node session", () => {
    const { broadcast, broadcastToConnIds, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });

    emitFallbackLifecycle({ handler, runId: "run-fallback" });

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");
    expect(payload.sessionKey).toBe("session-fallback");
    expect(payload.data?.activeProvider).toBe("deepinfra");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
  });

  it("remaps chat-linked lifecycle runId to client runId", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });
    chatRunState.registry.add("run-fallback-internal", {
      clientRunId: "run-fallback-client",
      sessionKey: "session-fallback",
    });

    emitFallbackLifecycle({ handler, runId: "run-fallback-internal" });

    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.runId).toBe("run-fallback-client");
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
    const nodePayload = nodeCalls[0]?.[2] as { runId?: string };
    expect(nodePayload.runId).toBe("run-fallback-client");
  });

  it("keeps chat-linked run remapping alive across per-attempt lifecycle errors", () => {
    vi.useFakeTimers();
    const { broadcast, chatRunState, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      lifecycleErrorRetryGraceMs: 100,
      resolveSessionKeyForRun: () => "session-fallback",
    });
    chatRunState.registry.add("run-fallback-retry", {
      clientRunId: "run-fallback-client",
      sessionKey: "session-fallback",
    });

    handler({
      data: { text: "draft" },
      runId: "run-fallback-retry",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });
    handler({
      data: { error: "provider failed", phase: "error" },
      runId: "run-fallback-retry",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
    });

    expect(chatRunState.registry.peek("run-fallback-retry")).toEqual({
      clientRunId: "run-fallback-client",
      sessionKey: "session-fallback",
    });
    expect(clearAgentRunContext).not.toHaveBeenCalled();
    expect(agentRunSeq.get("run-fallback-retry")).toBe(2);

    emitFallbackLifecycle({
      handler,
      runId: "run-fallback-retry",
      seq: 3,
      sessionKey: "session-fallback",
    });
    const agentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    const fallbackPayload = agentCalls.at(-1)?.[1] as {
      runId?: string;
      data?: Record<string, unknown>;
    };
    expect(fallbackPayload.runId).toBe("run-fallback-client");
    expect(fallbackPayload.data?.phase).toBe("fallback");

    emitLifecycleEnd(handler, "run-fallback-retry", 4);

    expect(
      chatBroadcastCalls(broadcast).some(
        ([, payload]) => (payload as { state?: string }).state === "error",
      ),
    ).toBe(false);
    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      runId?: string;
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.runId).toBe("run-fallback-client");
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-fallback-retry");
    expect(agentRunSeq.has("run-fallback-retry")).toBe(false);
  });

  it("defers terminal lifecycle-error cleanup for non-chat-send runs until the retry grace expires", () => {
    vi.useFakeTimers();
    const { broadcast, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      lifecycleErrorRetryGraceMs: 100,
      resolveSessionKeyForRun: () => "session-terminal-error",
    });
    registerAgentRunContext("run-terminal-error", { sessionKey: "session-terminal-error" });

    handler({
      data: { text: "partial" },
      runId: "run-terminal-error",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });
    handler({
      data: { error: "still broken", phase: "error" },
      runId: "run-terminal-error",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
    });

    expect(clearAgentRunContext).not.toHaveBeenCalled();
    expect(agentRunSeq.get("run-terminal-error")).toBe(2);
    expect(
      chatBroadcastCalls(broadcast).some(
        ([, payload]) => (payload as { state?: string }).state === "error",
      ),
    ).toBe(false);

    vi.advanceTimersByTime(100);

    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      runId?: string;
    };
    expect(finalPayload.state).toBe("error");
    expect(finalPayload.runId).toBe("run-terminal-error");
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-terminal-error");
    expect(agentRunSeq.has("run-terminal-error")).toBe(false);
  });

  it("adds detected errorKind to chat lifecycle error payloads", () => {
    const { broadcast, nodeSendToSession, handler } = createHarness({
      lifecycleErrorRetryGraceMs: 0,
      resolveSessionKeyForRun: () => "session-detected-error",
    });
    registerAgentRunContext("run-detected-error", { sessionKey: "session-detected-error" });

    handler({
      data: {
        error: Object.assign(new Error("Too many requests"), { code: 429 }),
        phase: "error",
      },
      runId: "run-detected-error",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
    });

    const payload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      errorKind?: string;
      errorMessage?: string;
    };
    expect(payload.state).toBe("error");
    expect(payload.errorKind).toBe("rate_limit");
    expect(payload.errorMessage).toContain("Too many requests");

    const nodePayload = sessionChatCalls(nodeSendToSession).at(-1)?.[2] as {
      errorKind?: string;
    };
    expect(nodePayload.errorKind).toBe("rate_limit");
  });

  it("suppresses delayed lifecycle chat errors for active chat.send runs while still cleaning up", () => {
    vi.useFakeTimers();
    const { broadcast, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      isChatSendRunActive: (runId) => runId === "run-chat-send",
      lifecycleErrorRetryGraceMs: 100,
      resolveSessionKeyForRun: () => "session-chat-send",
    });
    registerAgentRunContext("run-chat-send", { sessionKey: "session-chat-send" });

    handler({
      data: { text: "partial" },
      runId: "run-chat-send",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });
    handler({
      data: { error: "chat.send failed", phase: "error" },
      runId: "run-chat-send",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
    });

    vi.advanceTimersByTime(100);

    expect(
      chatBroadcastCalls(broadcast).some(
        ([, payload]) => (payload as { state?: string }).state === "error",
      ),
    ).toBe(false);
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-chat-send");
    expect(agentRunSeq.has("run-chat-send")).toBe(false);
  });

  it("suppresses chat and node session events for non-control-UI-visible runs", () => {
    const { broadcast, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-hidden",
    });
    registerAgentRunContext("run-hidden", {
      isControlUiVisible: false,
      sessionKey: "session-hidden",
      verboseLevel: "off",
    });

    handler({
      data: { text: "Reply from imessage" },
      runId: "run-hidden",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });
    emitLifecycleEnd(handler, "run-hidden", 2);

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(nodeSendToSession).not.toHaveBeenCalled();
  });

  it("uses agent event sessionKey when run-context lookup cannot resolve", () => {
    const { broadcast, handler } = createHarness({
      resolveSessionKeyForRun: () => undefined,
    });

    emitFallbackLifecycle({
      handler,
      runId: "run-fallback-session-key",
      sessionKey: "session-from-event",
    });

    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.sessionKey).toBe("session-from-event");
  });

  it("remaps chat-linked tool runId for non-full verbose payloads", () => {
    const { broadcastToConnIds, chatRunState, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-remap",
    });

    chatRunState.registry.add("run-tool-internal", {
      clientRunId: "run-tool-client",
      sessionKey: "session-tool-remap",
    });
    registerAgentRunContext("run-tool-internal", {
      sessionKey: "session-tool-remap",
      verboseLevel: "on",
    });
    toolEventRecipients.add("run-tool-internal", "conn-1");

    handler({
      data: {
        name: "exec",
        phase: "result",
        result: { content: [{ text: "secret", type: "text" }] },
        toolCallId: "tool-remap-1",
      },
      runId: "run-tool-internal",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { runId?: string };
    expect(payload.runId).toBe("run-tool-client");
    resetAgentRunContextForTest();
  });

  it("suppresses heartbeat ack-like chat output when showOk is false", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      now: 2000,
    });
    chatRunState.registry.add("run-heartbeat", {
      clientRunId: "client-heartbeat",
      sessionKey: "session-heartbeat",
    });
    registerAgentRunContext("run-heartbeat", {
      isHeartbeat: true,
      sessionKey: "session-heartbeat",
      verboseLevel: "off",
    });

    handler({
      data: {
        text: "HEARTBEAT_OK Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      },
      runId: "run-heartbeat",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);

    emitLifecycleEnd(handler, "run-heartbeat");

    const finalPayload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(finalPayload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
  });

  it("keeps heartbeat alert text in final chat output when remainder exceeds ackMaxChars", () => {
    vi.mocked(loadConfig).mockReturnValue({
      agents: { defaults: { heartbeat: { ackMaxChars: 10 } } },
    });

    const { broadcast, chatRunState, handler } = createHarness({ now: 3000 });
    chatRunState.registry.add("run-heartbeat-alert", {
      clientRunId: "client-heartbeat-alert",
      sessionKey: "session-heartbeat-alert",
    });
    registerAgentRunContext("run-heartbeat-alert", {
      isHeartbeat: true,
      sessionKey: "session-heartbeat-alert",
      verboseLevel: "off",
    });

    handler({
      data: {
        text: "HEARTBEAT_OK Disk usage crossed 95 percent on /data and needs cleanup now.",
      },
      runId: "run-heartbeat-alert",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
    });

    emitLifecycleEnd(handler, "run-heartbeat-alert");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: { content?: { text?: string }[] };
    };
    expect(payload.message?.content?.[0]?.text).toBe(
      "Disk usage crossed 95 percent on /data and needs cleanup now.",
    );
  });
});
