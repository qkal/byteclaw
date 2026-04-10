import { describe, expect, it, vi } from "vitest";
import { createEventHandlers } from "./tui-event-handlers.js";
import type { AgentEvent, BtwEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";

type MockFn = ReturnType<typeof vi.fn>;
interface HandlerChatLog {
  startTool: (...args: unknown[]) => void;
  updateToolResult: (...args: unknown[]) => void;
  addSystem: (...args: unknown[]) => void;
  updateAssistant: (...args: unknown[]) => void;
  finalizeAssistant: (...args: unknown[]) => void;
  dropAssistant: (...args: unknown[]) => void;
}
interface HandlerBtwPresenter {
  showResult: (...args: unknown[]) => void;
  clear: (...args: unknown[]) => void;
}
interface HandlerTui {
  requestRender: (...args: unknown[]) => void;
}
interface MockChatLog {
  startTool: MockFn;
  updateToolResult: MockFn;
  addSystem: MockFn;
  updateAssistant: MockFn;
  finalizeAssistant: MockFn;
  dropAssistant: MockFn;
}
interface MockBtwPresenter {
  showResult: MockFn;
  clear: MockFn;
}
interface MockTui {
  requestRender: MockFn;
}

function createMockChatLog(): MockChatLog & HandlerChatLog {
  return {
    addSystem: vi.fn(),
    dropAssistant: vi.fn(),
    finalizeAssistant: vi.fn(),
    startTool: vi.fn(),
    updateAssistant: vi.fn(),
    updateToolResult: vi.fn(),
  } as unknown as MockChatLog & HandlerChatLog;
}

function createMockBtwPresenter(): MockBtwPresenter & HandlerBtwPresenter {
  return {
    clear: vi.fn(),
    showResult: vi.fn(),
  } as unknown as MockBtwPresenter & HandlerBtwPresenter;
}

describe("tui-event-handlers: handleAgentEvent", () => {
  const makeState = (overrides?: Partial<TuiStateAccess>): TuiStateAccess => ({
    activeChatRunId: "run-1",
    activityStatus: "idle",
    agentDefaultId: "main",
    agents: [],
    autoMessageSent: false,
    connectionStatus: "connected",
    currentAgentId: "main",
    currentSessionId: "session-1",
    currentSessionKey: "agent:main:main",
    historyLoaded: true,
    initialSessionApplied: true,
    isConnected: true,
    lastCtrlCAt: 0,
    pendingOptimisticUserMessage: false,
    sessionInfo: { verboseLevel: "on" },
    sessionMainKey: "agent:main:main",
    sessionScope: "global",
    showThinking: false,
    statusTimeout: null,
    toolsExpanded: false,
    ...overrides,
  });

  const makeContext = (state: TuiStateAccess) => {
    const chatLog = createMockChatLog();
    const btw = createMockBtwPresenter();
    const tui = { requestRender: vi.fn() } as unknown as MockTui & HandlerTui;
    const setActivityStatus = vi.fn();
    const loadHistory = vi.fn();
    const localRunIds = new Set<string>();
    const localBtwRunIds = new Set<string>();
    const noteLocalRunId = (runId: string) => {
      localRunIds.add(runId);
    };
    const forgetLocalRunId = localRunIds.delete.bind(localRunIds);
    const isLocalRunId = localRunIds.has.bind(localRunIds);
    const clearLocalRunIds = localRunIds.clear.bind(localRunIds);
    const noteLocalBtwRunId = (runId: string) => {
      localBtwRunIds.add(runId);
    };
    const forgetLocalBtwRunId = localBtwRunIds.delete.bind(localBtwRunIds);
    const isLocalBtwRunId = localBtwRunIds.has.bind(localBtwRunIds);
    const clearLocalBtwRunIds = localBtwRunIds.clear.bind(localBtwRunIds);

    return {
      btw,
      chatLog,
      clearLocalBtwRunIds,
      clearLocalRunIds,
      forgetLocalBtwRunId,
      forgetLocalRunId,
      isLocalBtwRunId,
      isLocalRunId,
      loadHistory,
      noteLocalBtwRunId,
      noteLocalRunId,
      setActivityStatus,
      state,
      tui,
    };
  };

  const createHandlersHarness = (params?: {
    state?: Partial<TuiStateAccess>;
    chatLog?: HandlerChatLog;
    btw?: HandlerBtwPresenter;
  }) => {
    const state = makeState(params?.state);
    const context = makeContext(state);
    const chatLog = (params?.chatLog ?? context.chatLog) as MockChatLog & HandlerChatLog;
    const handlers = createEventHandlers({
      btw: (params?.btw ?? context.btw) as MockBtwPresenter & HandlerBtwPresenter,
      chatLog,
      clearLocalBtwRunIds: context.clearLocalBtwRunIds,
      forgetLocalBtwRunId: context.forgetLocalBtwRunId,
      forgetLocalRunId: context.forgetLocalRunId,
      isLocalBtwRunId: context.isLocalBtwRunId,
      isLocalRunId: context.isLocalRunId,
      loadHistory: context.loadHistory,
      noteLocalRunId: context.noteLocalRunId,
      setActivityStatus: context.setActivityStatus,
      state,
      tui: context.tui,
    });
    return {
      ...context,
      btw: (params?.btw ?? context.btw) as MockBtwPresenter & HandlerBtwPresenter,
      chatLog,
      state,
      ...handlers,
    };
  };

  it("processes tool events when runId matches activeChatRunId (even if sessionId differs)", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-123", currentSessionId: "session-xyz" },
    });

    const evt: AgentEvent = {
      data: {
        args: { command: "echo hi" },
        name: "exec",
        phase: "start",
        toolCallId: "tc1",
      },
      runId: "run-123",
      stream: "tool",
    };

    handleAgentEvent(evt);

    expect(chatLog.startTool).toHaveBeenCalledWith("tc1", "exec", { command: "echo hi" });
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("ignores tool events when runId does not match activeChatRunId", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-1" },
    });

    const evt: AgentEvent = {
      data: { name: "exec", phase: "start", toolCallId: "tc1" },
      runId: "run-2",
      stream: "tool",
    };

    handleAgentEvent(evt);

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(chatLog.updateToolResult).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("processes lifecycle events when runId matches activeChatRunId", () => {
    const chatLog = createMockChatLog();
    const { tui, setActivityStatus, handleAgentEvent } = createHandlersHarness({
      chatLog,
      state: { activeChatRunId: "run-9" },
    });

    const evt: AgentEvent = {
      data: { phase: "start" },
      runId: "run-9",
      stream: "lifecycle",
    };

    handleAgentEvent(evt);

    expect(setActivityStatus).toHaveBeenCalledWith("running");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("captures runId from chat events when activeChatRunId is unset", () => {
    const { state, chatLog, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    const chatEvt: ChatEvent = {
      message: { content: "hello" },
      runId: "run-42",
      sessionKey: state.currentSessionKey,
      state: "delta",
    };

    handleChatEvent(chatEvt);

    expect(state.activeChatRunId).toBe("run-42");

    const agentEvt: AgentEvent = {
      data: { name: "exec", phase: "start", toolCallId: "tc1" },
      runId: "run-42",
      stream: "tool",
    };

    handleAgentEvent(agentEvt);

    expect(chatLog.startTool).toHaveBeenCalledWith("tc1", "exec", undefined);
  });

  it("accepts chat events when session key is an alias of the active canonical key", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: {
        activeChatRunId: null,
        currentSessionKey: "agent:main:main",
      },
    });

    handleChatEvent({
      message: { content: "hello" },
      runId: "run-alias",
      sessionKey: "main",
      state: "delta",
    });

    expect(state.activeChatRunId).toBe("run-alias");
    expect(chatLog.updateAssistant).toHaveBeenCalledWith("hello", "run-alias");
  });

  it("renders BTW results separately without disturbing the active run", () => {
    const { state, btw, setActivityStatus, loadHistory, tui, handleBtwEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-main" },
      });

    const evt: BtwEvent = {
      kind: "btw",
      question: "what changed?",
      runId: "run-btw",
      sessionKey: state.currentSessionKey,
      text: "nothing important",
    };

    handleBtwEvent(evt);

    expect(state.activeChatRunId).toBe("run-main");
    expect(btw.showResult).toHaveBeenCalledWith({
      isError: undefined,
      question: "what changed?",
      text: "nothing important",
    });
    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("keeps a local BTW result visible when its empty final chat event arrives", () => {
    const { state, btw, loadHistory, noteLocalBtwRunId, handleBtwEvent, handleChatEvent } =
      createHandlersHarness({
        state: { activeChatRunId: null },
      });

    noteLocalBtwRunId("run-btw");
    handleBtwEvent({
      kind: "btw",
      question: "what changed?",
      runId: "run-btw",
      sessionKey: state.currentSessionKey,
      text: "nothing important",
    } satisfies BtwEvent);

    handleChatEvent({
      runId: "run-btw",
      sessionKey: state.currentSessionKey,
      state: "final",
    } satisfies ChatEvent);

    expect(loadHistory).not.toHaveBeenCalled();
    expect(btw.showResult).toHaveBeenCalledWith({
      isError: undefined,
      question: "what changed?",
      text: "nothing important",
    });
  });

  it("does not cross-match canonical session keys from different agents", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: {
        activeChatRunId: null,
        currentAgentId: "alpha",
        currentSessionKey: "agent:alpha:main",
      },
    });

    handleChatEvent({
      message: { content: "should be ignored" },
      runId: "run-other-agent",
      sessionKey: "agent:beta:main",
      state: "delta",
    });

    expect(chatLog.updateAssistant).not.toHaveBeenCalled();
  });

  it("clears run mapping when the session changes", () => {
    const { state, chatLog, tui, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      message: { content: "hello" },
      runId: "run-old",
      sessionKey: state.currentSessionKey,
      state: "delta",
    });

    state.currentSessionKey = "agent:main:other";
    state.activeChatRunId = null;
    tui.requestRender.mockClear();

    handleAgentEvent({
      data: { name: "exec", phase: "start", toolCallId: "tc2" },
      runId: "run-old",
      stream: "tool",
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("accepts tool events after chat final for the same run", () => {
    const { state, chatLog, tui, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      message: { content: [{ text: "done", type: "text" }] },
      runId: "run-final",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    handleAgentEvent({
      data: { name: "session_status", phase: "start", toolCallId: "tc-final" },
      runId: "run-final",
      stream: "tool",
    });

    expect(chatLog.startTool).toHaveBeenCalledWith("tc-final", "session_status", undefined);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("ignores lifecycle updates for non-active runs in the same session", () => {
    const { state, tui, setActivityStatus, handleChatEvent, handleAgentEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-active" },
      });

    handleChatEvent({
      message: { content: "hello" },
      runId: "run-other",
      sessionKey: state.currentSessionKey,
      state: "delta",
    });
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();

    handleAgentEvent({
      data: { phase: "end" },
      runId: "run-other",
      stream: "lifecycle",
    });

    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("suppresses tool events when verbose is off", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-123",
        sessionInfo: { verboseLevel: "off" },
      },
    });

    handleAgentEvent({
      data: { name: "session_status", phase: "start", toolCallId: "tc-off" },
      runId: "run-123",
      stream: "tool",
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("omits tool output when verbose is on (non-full)", () => {
    const { chatLog, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-123",
        sessionInfo: { verboseLevel: "on" },
      },
    });

    handleAgentEvent({
      data: {
        name: "session_status",
        partialResult: { content: [{ text: "secret", type: "text" }] },
        phase: "update",
        toolCallId: "tc-on",
      },
      runId: "run-123",
      stream: "tool",
    });

    handleAgentEvent({
      data: {
        isError: false,
        name: "session_status",
        phase: "result",
        result: { content: [{ text: "secret", type: "text" }] },
        toolCallId: "tc-on",
      },
      runId: "run-123",
      stream: "tool",
    });

    expect(chatLog.updateToolResult).toHaveBeenCalledTimes(1);
    expect(chatLog.updateToolResult).toHaveBeenCalledWith(
      "tc-on",
      { content: [] },
      { isError: false },
    );
  });

  it("refreshes history after a non-local chat final", () => {
    const { state, loadHistory, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      message: { content: [{ text: "done", type: "text" }] },
      runId: "external-run",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("binds optimistic pending messages to the first gateway run id and skips history reload", () => {
    const { state, loadHistory, isLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null, pendingOptimisticUserMessage: true },
    });

    handleChatEvent({
      message: { content: [{ text: "done", type: "text" }] },
      runId: "run-gateway",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(state.pendingOptimisticUserMessage).toBe(false);
    expect(state.activeChatRunId).toBeNull();
    expect(isLocalRunId("run-gateway")).toBe(false);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  function createConcurrentRunHarness(localContent = "partial") {
    const { state, chatLog, setActivityStatus, loadHistory, handleChatEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-active" },
      });

    handleChatEvent({
      message: { content: localContent },
      runId: "run-active",
      sessionKey: state.currentSessionKey,
      state: "delta",
    });

    return { chatLog, handleChatEvent, loadHistory, setActivityStatus, state };
  }

  it("does not reload history or clear active run when another run final arrives mid-stream", () => {
    const { state, chatLog, setActivityStatus, loadHistory, handleChatEvent } =
      createConcurrentRunHarness("partial");

    loadHistory.mockClear();
    setActivityStatus.mockClear();

    handleChatEvent({
      message: { content: [{ text: "other final", type: "text" }] },
      runId: "run-other",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");

    handleChatEvent({
      message: { content: "continued" },
      runId: "run-active",
      sessionKey: state.currentSessionKey,
      state: "delta",
    });

    expect(chatLog.updateAssistant).toHaveBeenLastCalledWith("continued", "run-active");
  });

  it("suppresses non-local empty final placeholders during concurrent runs", () => {
    const { state, chatLog, loadHistory, handleChatEvent } =
      createConcurrentRunHarness("local stream");

    loadHistory.mockClear();
    chatLog.finalizeAssistant.mockClear();
    chatLog.dropAssistant.mockClear();

    handleChatEvent({
      message: { content: [] },
      runId: "run-other",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(chatLog.finalizeAssistant).not.toHaveBeenCalledWith("(no output)", "run-other");
    expect(chatLog.dropAssistant).toHaveBeenCalledWith("run-other");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
  });

  it("renders final error text when chat final has no content but includes event errorMessage", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      errorMessage: '401 {"error":{"message":"Missing scopes: model.request"}}',
      message: { content: [] },
      runId: "run-error-envelope",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    const [rendered] = chatLog.finalizeAssistant.mock.calls[0] ?? [];
    expect(String(rendered)).toContain("HTTP 401");
    expect(String(rendered)).toContain("Missing scopes: model.request");
    expect(chatLog.dropAssistant).not.toHaveBeenCalledWith("run-error-envelope");
  });

  it("drops streaming assistant when chat final has no message", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      message: { content: "hello" },
      runId: "run-silent",
      sessionKey: state.currentSessionKey,
      state: "delta",
    });
    chatLog.dropAssistant.mockClear();
    chatLog.finalizeAssistant.mockClear();

    handleChatEvent({
      runId: "run-silent",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(chatLog.dropAssistant).toHaveBeenCalledWith("run-silent");
    expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
  });

  it("reloads history when a local run ends without a displayable final message", () => {
    const { state, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-local-silent" },
    });

    noteLocalRunId("run-local-silent");

    handleChatEvent({
      runId: "run-local-silent",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("does not reload history for local run with empty final when another run is active (#53115)", () => {
    const { state, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-main" },
    });

    noteLocalRunId("run-local-empty");

    handleChatEvent({
      runId: "run-local-empty",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(state.activeChatRunId).toBe("run-main");
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("flushes deferred history reload after the newer local run finishes", () => {
    const { state, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-main" },
    });

    noteLocalRunId("run-local-empty");
    handleChatEvent({
      runId: "run-local-empty",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    noteLocalRunId("run-main");
    handleChatEvent({
      message: { content: [{ text: "done", type: "text" }] },
      runId: "run-main",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
});
