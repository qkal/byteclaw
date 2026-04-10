import { describe, expect, it, vi } from "vitest";
import type { GatewayChatClient } from "./gateway-chat.js";
import { createSessionActions } from "./tui-session-actions.js";
import type { TuiStateAccess } from "./tui-types.js";

describe("tui session actions", () => {
  const createBtwPresenter = () => ({
    clear: vi.fn(),
    showResult: vi.fn(),
  });

  it("queues session refreshes and applies the latest result", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;

    const listSessions = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const state: TuiStateAccess = {
      activeChatRunId: null,
      activityStatus: "idle",
      agentDefaultId: "main",
      agents: [],
      autoMessageSent: false,
      connectionStatus: "connected",
      currentAgentId: "main",
      currentSessionId: null,
      currentSessionKey: "agent:main:main",
      historyLoaded: false,
      initialSessionApplied: true,
      isConnected: true,
      lastCtrlCAt: 0,
      sessionInfo: {},
      sessionMainKey: "agent:main:main",
      sessionScope: "global",
      showThinking: false,
      statusTimeout: null,
      toolsExpanded: false,
    };

    const updateFooter = vi.fn();
    const updateAutocompleteProvider = vi.fn();
    const requestRender = vi.fn();

    const { refreshSessionInfo } = createSessionActions({
      agentNames: new Map(),
      btw: createBtwPresenter(),
      chatLog: { addSystem: vi.fn() } as unknown as import("./components/chat-log.js").ChatLog,
      client: { listSessions } as unknown as GatewayChatClient,
      initialSessionAgentId: null,
      initialSessionInput: "",
      opts: {},
      resolveSessionKey: vi.fn(),
      setActivityStatus: vi.fn(),
      state,
      tui: { requestRender } as unknown as import("@mariozechner/pi-tui").TUI,
      updateAutocompleteProvider,
      updateFooter,
      updateHeader: vi.fn(),
    });

    const first = refreshSessionInfo();
    const second = refreshSessionInfo();

    await Promise.resolve();
    expect(listSessions).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      count: 1,
      defaults: {},
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:main",
          model: "old",
          modelProvider: "anthropic",
        },
      ],
      ts: Date.now(),
    });

    await first;
    await Promise.resolve();

    expect(listSessions).toHaveBeenCalledTimes(2);

    resolveSecond?.({
      count: 1,
      defaults: {},
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:main",
          model: "Minimax-M2.7",
          modelProvider: "minimax",
        },
      ],
      ts: Date.now(),
    });

    await second;

    expect(state.sessionInfo.model).toBe("Minimax-M2.7");
    expect(updateAutocompleteProvider).toHaveBeenCalledTimes(2);
    expect(updateFooter).toHaveBeenCalledTimes(2);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("keeps patched model selection when a refresh returns an older snapshot", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      count: 1,
      defaults: {},
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:main",
          model: "old-model",
          modelProvider: "ollama",
          updatedAt: 100,
        },
      ],
      ts: Date.now(),
    });

    const state: TuiStateAccess = {
      activeChatRunId: null,
      activityStatus: "idle",
      agentDefaultId: "main",
      agents: [],
      autoMessageSent: false,
      connectionStatus: "connected",
      currentAgentId: "main",
      currentSessionId: null,
      currentSessionKey: "agent:main:main",
      historyLoaded: false,
      initialSessionApplied: true,
      isConnected: true,
      lastCtrlCAt: 0,
      sessionInfo: {
        model: "old-model",
        modelProvider: "ollama",
        updatedAt: 100,
      },
      sessionMainKey: "agent:main:main",
      sessionScope: "global",
      showThinking: false,
      statusTimeout: null,
      toolsExpanded: false,
    };

    const { applySessionInfoFromPatch, refreshSessionInfo } = createSessionActions({
      agentNames: new Map(),
      btw: createBtwPresenter(),
      chatLog: { addSystem: vi.fn() } as unknown as import("./components/chat-log.js").ChatLog,
      client: { listSessions } as unknown as GatewayChatClient,
      initialSessionAgentId: null,
      initialSessionInput: "",
      opts: {},
      resolveSessionKey: vi.fn(),
      setActivityStatus: vi.fn(),
      state,
      tui: { requestRender: vi.fn() } as unknown as import("@mariozechner/pi-tui").TUI,
      updateAutocompleteProvider: vi.fn(),
      updateFooter: vi.fn(),
      updateHeader: vi.fn(),
    });

    applySessionInfoFromPatch({
      entry: {
        model: "new-model",
        modelProvider: "openai",
        sessionId: "session-1",
        updatedAt: 200,
      },
      key: "agent:main:main",
      ok: true,
      path: "/tmp/sessions.json",
    });

    expect(state.sessionInfo.model).toBe("new-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");

    await refreshSessionInfo();

    expect(state.sessionInfo.model).toBe("new-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(state.sessionInfo.updatedAt).toBe(200);
  });

  it("accepts older session snapshots after switching session keys", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      count: 1,
      defaults: {},
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:other",
          model: "session-model",
          modelProvider: "openai",
          updatedAt: 50,
        },
      ],
      ts: Date.now(),
    });
    const loadHistory = vi.fn().mockResolvedValue({
      messages: [],
      sessionId: "session-2",
    });
    const btw = createBtwPresenter();

    const state: TuiStateAccess = {
      activeChatRunId: null,
      activityStatus: "idle",
      agentDefaultId: "main",
      agents: [],
      autoMessageSent: false,
      connectionStatus: "connected",
      currentAgentId: "main",
      currentSessionId: null,
      currentSessionKey: "agent:main:main",
      historyLoaded: true,
      initialSessionApplied: true,
      isConnected: true,
      lastCtrlCAt: 0,
      sessionInfo: {
        model: "previous-model",
        modelProvider: "anthropic",
        updatedAt: 500,
      },
      sessionMainKey: "agent:main:main",
      sessionScope: "global",
      showThinking: false,
      statusTimeout: null,
      toolsExpanded: false,
    };

    const setActivityStatus = vi.fn();
    const { setSession } = createSessionActions({
      agentNames: new Map(),
      btw,
      chatLog: {
        addSystem: vi.fn(),
        clearAll: vi.fn(),
      } as unknown as import("./components/chat-log.js").ChatLog,
      client: {
        listSessions,
        loadHistory,
      } as unknown as GatewayChatClient,
      initialSessionAgentId: null,
      initialSessionInput: "",
      opts: {},
      resolveSessionKey: vi.fn((raw?: string) => raw ?? "agent:main:main"),
      setActivityStatus,
      state,
      tui: { requestRender: vi.fn() } as unknown as import("@mariozechner/pi-tui").TUI,
      updateAutocompleteProvider: vi.fn(),
      updateFooter: vi.fn(),
      updateHeader: vi.fn(),
    });

    await setSession("agent:main:other");

    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(loadHistory).toHaveBeenCalledWith({
      limit: 200,
      sessionKey: "agent:main:other",
    });
    expect(state.currentSessionKey).toBe("agent:main:other");
    expect(state.sessionInfo.model).toBe("session-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(state.sessionInfo.updatedAt).toBe(50);
    expect(btw.clear).toHaveBeenCalled();
  });

  it("resets activity status to idle when switching sessions after streaming", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      count: 0,
      defaults: {},
      path: "/tmp/sessions.json",
      sessions: [],
      ts: Date.now(),
    });
    const loadHistory = vi.fn().mockResolvedValue({
      messages: [],
      sessionId: "session-b",
    });
    const setActivityStatus = vi.fn();

    const state: TuiStateAccess = {
      activeChatRunId: "run-1",
      activityStatus: "streaming",
      agentDefaultId: "main",
      agents: [],
      autoMessageSent: false,
      connectionStatus: "connected",
      currentAgentId: "main",
      currentSessionId: null,
      currentSessionKey: "agent:main:main",
      historyLoaded: true,
      initialSessionApplied: true,
      isConnected: true,
      lastCtrlCAt: 0,
      sessionInfo: {},
      sessionMainKey: "agent:main:main",
      sessionScope: "global",
      showThinking: false,
      statusTimeout: null,
      toolsExpanded: false,
    };

    const { setSession } = createSessionActions({
      agentNames: new Map(),
      btw: createBtwPresenter(),
      chatLog: {
        addSystem: vi.fn(),
        clearAll: vi.fn(),
      } as unknown as import("./components/chat-log.js").ChatLog,
      client: {
        listSessions,
        loadHistory,
      } as unknown as GatewayChatClient,
      initialSessionAgentId: null,
      initialSessionInput: "",
      opts: {},
      resolveSessionKey: vi.fn((raw?: string) => raw ?? "agent:main:main"),
      setActivityStatus,
      state,
      tui: { requestRender: vi.fn() } as unknown as import("@mariozechner/pi-tui").TUI,
      updateAutocompleteProvider: vi.fn(),
      updateFooter: vi.fn(),
      updateHeader: vi.fn(),
    });

    await setSession("agent:main:other");

    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBeNull();
  });
});
