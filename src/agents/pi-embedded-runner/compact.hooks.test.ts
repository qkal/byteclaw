import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyExtraParamsToAgentMock,
  contextEngineCompactMock,
  ensureRuntimePluginsLoaded,
  estimateTokensMock,
  getMemorySearchManagerMock,
  hookRunner,
  loadCompactHooksHarness,
  registerProviderStreamForModelMock,
  resetCompactHooksHarnessMocks,
  resetCompactSessionStateMocks,
  resolveContextEngineMock,
  resolveEmbeddedAgentStreamFnMock,
  resolveMemorySearchConfigMock,
  resolveModelMock,
  resolveSessionAgentIdMock,
  sessionAbortCompactionMock,
  sessionCompactImpl,
  sessionMessages,
  triggerInternalHook,
} from "./compact.hooks.harness.js";

let compactEmbeddedPiSessionDirect: typeof import("./compact.js").compactEmbeddedPiSessionDirect;
let compactEmbeddedPiSession: typeof import("./compact.js").compactEmbeddedPiSession;
let compactTesting: typeof import("./compact.js").__testing;
let onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;

const TEST_SESSION_ID = "session-1";
const TEST_SESSION_KEY = "agent:main:session-1";
const TEST_SESSION_FILE = "/tmp/session.jsonl";
const TEST_WORKSPACE_DIR = "/tmp";
const TEST_CUSTOM_INSTRUCTIONS = "focus on decisions";
interface SessionHookEvent {
  type?: string;
  action?: string;
  sessionKey?: string;
  context?: Record<string, unknown>;
}
interface PostCompactionSyncParams {
  reason: string;
  sessionFiles: string[];
}
type PostCompactionSync = (params?: unknown) => Promise<void>;
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function mockResolvedModel() {
  resolveModelMock.mockReset();
  resolveModelMock.mockReturnValue({
    authStorage: { setRuntimeApiKey: vi.fn() },
    error: null,
    model: { api: "responses", id: "fake", input: [], provider: "openai" },
    modelRegistry: {},
  });
}

function compactionConfig(mode: "await" | "off" | "async") {
  return {
    agents: {
      defaults: {
        compaction: {
          postIndexSync: mode,
        },
      },
    },
  } as never;
}

function wrappedCompactionArgs(overrides: Record<string, unknown> = {}) {
  return {
    customInstructions: TEST_CUSTOM_INSTRUCTIONS,
    enqueue: async <T>(task: () => Promise<T> | T) => await task(),
    sessionFile: TEST_SESSION_FILE,
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_SESSION_KEY,
    workspaceDir: TEST_WORKSPACE_DIR,
    ...overrides,
  };
}

const sessionHook = (action: string): SessionHookEvent | undefined =>
  triggerInternalHook.mock.calls.find((call) => {
    const event = call[0] as SessionHookEvent | undefined;
    return event?.type === "session" && event.action === action;
  })?.[0] as SessionHookEvent | undefined;

async function runCompactionHooks(params: { sessionKey?: string; messageProvider?: string }) {
  const originalMessages = sessionMessages.slice(1) as AgentMessage[];
  const currentMessages = sessionMessages.slice(1) as AgentMessage[];
  const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
    currentMessages,
    estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    originalMessages,
  });

  const hookState = await compactTesting.runBeforeCompactionHooks({
    hookRunner,
    messageProvider: params.messageProvider,
    metrics: beforeMetrics,
    sessionAgentId: "main",
    sessionId: TEST_SESSION_ID,
    sessionKey: params.sessionKey,
    workspaceDir: TEST_WORKSPACE_DIR,
  });

  await compactTesting.runAfterCompactionHooks({
    compactedCount: 1,
    firstKeptEntryId: "entry-1",
    hookRunner,
    hookSessionKey: hookState.hookSessionKey,
    messageCountAfter: 1,
    messageProvider: params.messageProvider,
    missingSessionKey: hookState.missingSessionKey,
    sessionAgentId: "main",
    sessionFile: TEST_SESSION_FILE,
    sessionId: TEST_SESSION_ID,
    summaryLength: "summary".length,
    tokensAfter: 10,
    tokensBefore: 120,
    workspaceDir: TEST_WORKSPACE_DIR,
  });
}

beforeAll(async () => {
  const loaded = await loadCompactHooksHarness();
  ({ compactEmbeddedPiSessionDirect } = loaded);
  ({ compactEmbeddedPiSession } = loaded);
  compactTesting = loaded.__testing;
  ({ onSessionTranscriptUpdate } = loaded);
});

beforeEach(() => {
  resetCompactHooksHarnessMocks();
});

describe("compactEmbeddedPiSessionDirect hooks", () => {
  beforeEach(() => {
    ensureRuntimePluginsLoaded.mockReset();
    triggerInternalHook.mockClear();
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    mockResolvedModel();
    sessionCompactImpl.mockReset();
    sessionCompactImpl.mockResolvedValue({
      details: { ok: true },
      firstKeptEntryId: "entry-1",
      summary: "summary",
      tokensBefore: 120,
    });
    resetCompactSessionStateMocks();
  });

  it("bootstraps runtime plugins with the resolved workspace", async () => {
    // This assertion only cares about bootstrap wiring, so stop before the
    // Rest of the compaction pipeline can pull in unrelated runtime surfaces.
    resolveModelMock.mockReturnValue({
      authStorage: { setRuntimeApiKey: vi.fn() },
      error: "stop after bootstrap",
      model: undefined,
      modelRegistry: {},
    } as never);

    await compactEmbeddedPiSessionDirect({
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      workspaceDir: "/tmp/workspace",
    });

    expect(ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("forwards gateway subagent binding opt-in during compaction bootstrap", async () => {
    // Coding-tool forwarding is covered elsewhere; this compaction test only
    // Owns the runtime bootstrap wiring.
    resolveModelMock.mockReturnValue({
      authStorage: { setRuntimeApiKey: vi.fn() },
      error: "stop after bootstrap",
      model: undefined,
      modelRegistry: {},
    } as never);

    await compactEmbeddedPiSessionDirect({
      allowGatewaySubagentBinding: true,
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      workspaceDir: "/tmp/workspace",
    });

    expect(ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      allowGatewaySubagentBinding: true,
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("routes compaction through shared stream resolution and extra params", async () => {
    const resolvedStreamFn = vi.fn();
    resolveEmbeddedAgentStreamFnMock.mockReturnValue(resolvedStreamFn);
    applyExtraParamsToAgentMock.mockReturnValue({
      effectiveExtraParams: { transport: "websocket" },
    });
    const session = {
      agent: {
        streamFn: vi.fn(),
      },
      messages: [{ content: "hello", role: "user" }],
    };

    compactTesting.prepareCompactionSessionAgent({
      agentDir: "/tmp/workspace",
      authStorage: { setRuntimeApiKey: vi.fn() },
      config: undefined,
      effectiveModel: { api: "responses", id: "fake", input: [], provider: "openai" } as never,
      effectiveWorkspace: "/tmp/workspace",
      modelId: "gpt-5.4",
      provider: "openai",
      providerStreamFn: vi.fn(),
      resolvedApiKey: undefined,
      session: session as never,
      sessionAgentId: "main",
      sessionId: "session-1",
      shouldUseWebSocketTransport: false,
      signal: new AbortController().signal,
      thinkLevel: "off",
    });

    expect(resolveEmbeddedAgentStreamFnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentStreamFn: expect.any(Function),
        sessionId: "session-1",
      }),
    );
    expect(applyExtraParamsToAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        streamFn: resolvedStreamFn,
      }),
      undefined,
      "openai",
      "gpt-5.4",
      undefined,
      "off",
      "main",
      "/tmp/workspace",
      expect.objectContaining({
        api: "responses",
        id: "fake",
        provider: "openai",
      }),
      "/tmp/workspace",
    );
  });

  it("emits internal + plugin compaction hooks with counts", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    await runCompactionHooks({
      messageProvider: "telegram",
      sessionKey: TEST_SESSION_KEY,
    });

    expect(sessionHook("compact:before")).toMatchObject({
      action: "compact:before",
      type: "session",
    });
    const beforeContext = sessionHook("compact:before")?.context;
    const afterContext = sessionHook("compact:after")?.context;

    expect(beforeContext).toMatchObject({
      messageCount: 2,
      messageCountOriginal: 2,
      tokenCount: 20,
      tokenCountOriginal: 20,
    });
    expect(afterContext).toMatchObject({
      compactedCount: 1,
      messageCount: 1,
    });
    expect(afterContext?.compactedCount).toBe(
      (beforeContext?.messageCountOriginal as number) - (afterContext?.messageCount as number),
    );

    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageCount: 2,
        tokenCount: 20,
      }),
      expect.objectContaining({ messageProvider: "telegram", sessionKey: "agent:main:session-1" }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      {
        compactedCount: 1,
        messageCount: 1,
        sessionFile: "/tmp/session.jsonl",
        tokenCount: 10,
      },
      expect.objectContaining({ messageProvider: "telegram", sessionKey: "agent:main:session-1" }),
    );
  });

  it("uses sessionId as hook session key fallback when sessionKey is missing", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    await runCompactionHooks({});

    expect(sessionHook("compact:before")?.sessionKey).toBe("session-1");
    expect(sessionHook("compact:after")?.sessionKey).toBe("session-1");
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ sessionKey: "session-1" }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ sessionKey: "session-1" }),
    );
  });

  it("applies validated transcript before hooks even when it becomes empty", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
      currentMessages: [],
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
      originalMessages: [],
    });
    await compactTesting.runBeforeCompactionHooks({
      hookRunner,
      metrics: beforeMetrics,
      sessionAgentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      workspaceDir: "/tmp",
    });

    const beforeContext = sessionHook("compact:before")?.context;
    expect(beforeContext).toMatchObject({
      messageCount: 0,
      messageCountOriginal: 0,
      tokenCount: 0,
      tokenCountOriginal: 0,
    });
  });
  it("emits a transcript update after successful compaction", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);

    try {
      await compactTesting.runPostCompactionSideEffects({
        sessionFile: "  /tmp/session.jsonl  ",
        sessionKey: "agent:main:session-1",
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ sessionFile: "/tmp/session.jsonl" });
    } finally {
      cleanup();
    }
  });

  it("preserves tokensAfter when full-session context exceeds result.tokensBefore", async () => {
    estimateTokensMock.mockImplementation((message: unknown) => {
      const {role} = (message as { role?: string });
      if (role === "user") {
        return 30;
      }
      if (role === "assistant") {
        return 20;
      }
      return 5;
    });
    const tokensAfter = compactTesting.estimateTokensAfterCompaction({
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
      fullSessionTokensBefore: 55,
      messagesAfter: [{ content: "kept ask", role: "user" }] as AgentMessage[],
    });

    expect(tokensAfter).toBe(30);
  });

  it("treats pre-compaction token estimation failures as a no-op sanity check", async () => {
    estimateTokensMock.mockImplementation((message: unknown) => {
      const {role} = (message as { role?: string });
      if (role === "assistant") {
        throw new Error("legacy message");
      }
      if (role === "user") {
        return 30;
      }
      return 5;
    });
    const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
      currentMessages: sessionMessages as AgentMessage[],
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
      originalMessages: sessionMessages as AgentMessage[],
    });
    const tokensAfter = compactTesting.estimateTokensAfterCompaction({
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
      fullSessionTokensBefore: 0,
      messagesAfter: [{ content: "kept ask", role: "user" }] as AgentMessage[],
    });

    expect(beforeMetrics.tokenCountOriginal).toBeUndefined();
    expect(beforeMetrics.tokenCountBefore).toBeUndefined();
    expect(tokensAfter).toBe(30);
  });

  it("skips sync in await mode when postCompactionForce is false", async () => {
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    resolveMemorySearchConfigMock.mockReturnValue({
      sources: ["sessions"],
      sync: {
        sessions: {
          postCompactionForce: false,
        },
      },
    });

    await compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("await"),
      sessionFile: TEST_SESSION_FILE,
      sessionKey: TEST_SESSION_KEY,
    });

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      config: expect.any(Object),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("awaits post-compaction memory sync in await mode when postCompactionForce is true", async () => {
    const syncStarted = createDeferred<PostCompactionSyncParams>();
    const syncRelease = createDeferred<void>();
    const sync = vi.fn<PostCompactionSync>(async (params) => {
      syncStarted.resolve(params as PostCompactionSyncParams);
      await syncRelease.promise;
    });
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    let settled = false;

    const resultPromise = compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("await"),
      sessionFile: TEST_SESSION_FILE,
      sessionKey: TEST_SESSION_KEY,
    });

    void resultPromise.then(() => {
      settled = true;
    });
    await expect(syncStarted.promise).resolves.toEqual({
      reason: "post-compaction",
      sessionFiles: [TEST_SESSION_FILE],
    });
    expect(settled).toBe(false);
    syncRelease.resolve(undefined);
    await resultPromise;
    expect(settled).toBe(true);
  });

  it("skips post-compaction memory sync when the mode is off", async () => {
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    await compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("off"),
      sessionFile: TEST_SESSION_FILE,
      sessionKey: TEST_SESSION_KEY,
    });

    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("fires post-compaction memory sync without awaiting it in async mode", async () => {
    const sync = vi.fn<PostCompactionSync>(async () => {});
    const managerRequested = createDeferred<void>();
    const managerGate = createDeferred<{ manager: { sync: PostCompactionSync } }>();
    const syncStarted = createDeferred<PostCompactionSyncParams>();
    sync.mockImplementation(async (params) => {
      syncStarted.resolve(params as PostCompactionSyncParams);
    });
    getMemorySearchManagerMock.mockImplementation(async () => {
      managerRequested.resolve(undefined);
      return await managerGate.promise;
    });
    let settled = false;

    const resultPromise = compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("async"),
      sessionFile: TEST_SESSION_FILE,
      sessionKey: TEST_SESSION_KEY,
    });

    await managerRequested.promise;
    void resultPromise.then(() => {
      settled = true;
    });
    await resultPromise;
    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    managerGate.resolve({ manager: { sync } });
    await expect(syncStarted.promise).resolves.toEqual({
      reason: "post-compaction",
      sessionFiles: [TEST_SESSION_FILE],
    });
  });

  it("skips compaction when the transcript only contains boilerplate replies and tool output", async () => {
    const messages = [
      { content: "<b>HEARTBEAT_OK</b>", role: "user", timestamp: 1 },
      {
        content: [{ text: "checked", type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: 2,
        toolCallId: "t1",
        toolName: "exec",
      },
    ] as AgentMessage[];

    expect(compactTesting.containsRealConversationMessages(messages)).toBe(false);
  });

  it("skips compaction when the transcript only contains heartbeat boilerplate and reasoning blocks", async () => {
    const messages = [
      { content: "<b>HEARTBEAT_OK</b>", role: "user", timestamp: 1 },
      {
        content: [{ thinking: "checking", type: "thinking" }],
        role: "assistant",
        timestamp: 2,
      },
    ] as AgentMessage[];

    expect(compactTesting.containsRealConversationMessages(messages)).toBe(false);
  });

  it("does not treat assistant-only tool-call blocks as meaningful conversation", () => {
    expect(
      compactTesting.hasMeaningfulConversationContent({
        content: [{ arguments: {}, id: "call_1", name: "exec", type: "toolCall" }],
        role: "assistant",
      } as AgentMessage),
    ).toBe(false);
  });

  it("counts tool output as real only when a meaningful user ask exists in the lookback window", () => {
    const heartbeatToolResultWindow = [
      { content: "<b>HEARTBEAT_OK</b>", role: "user" },
      {
        content: [{ text: "checked", type: "text" }],
        role: "toolResult",
        toolCallId: "t1",
        toolName: "exec",
      },
    ] as AgentMessage[];
    expect(
      compactTesting.hasRealConversationContent(
        heartbeatToolResultWindow[1],
        heartbeatToolResultWindow,
        1,
      ),
    ).toBe(false);

    const realAskToolResultWindow = [
      { content: "NO_REPLY", role: "assistant" },
      { content: "please inspect the failing PR", role: "user" },
      {
        content: [{ text: "checked", type: "text" }],
        role: "toolResult",
        toolCallId: "t2",
        toolName: "exec",
      },
    ] as AgentMessage[];
    expect(
      compactTesting.hasRealConversationContent(
        realAskToolResultWindow[2],
        realAskToolResultWindow,
        2,
      ),
    ).toBe(true);
  });

  it("registers the Ollama api provider before compaction", async () => {
    const streamFn = vi.fn();
    registerProviderStreamForModelMock.mockReturnValue(streamFn);

    const result = compactTesting.resolveCompactionProviderStream({
      agentDir: "/tmp",
      config: undefined,
      effectiveModel: {
        api: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        headers: { Authorization: "Bearer ollama-cloud" },
        id: "qwen3:8b",
        input: ["text"],
        provider: "ollama",
      } as never,
      effectiveWorkspace: "/tmp",
    });

    expect(result).toBe(streamFn);
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp",
        model: expect.objectContaining({
          api: "ollama",
          id: "qwen3:8b",
          provider: "ollama",
        }),
        workspaceDir: "/tmp",
      }),
    );
  });

  it("aborts in-flight compaction when the caller abort signal fires", async () => {
    const { compactWithSafetyTimeout } = await vi.importActual<
      typeof import("./compaction-safety-timeout.js")
    >("./compaction-safety-timeout.js");
    const controller = new AbortController();
    const compactStarted = createDeferred<void>();

    const resultPromise = compactWithSafetyTimeout(
      async () => {
        compactStarted.resolve(undefined);
        return await new Promise<never>(() => {});
      },
      30_000,
      {
        abortSignal: controller.signal,
        onCancel: () => {
          sessionAbortCompactionMock();
        },
      },
    );

    await compactStarted.promise;
    controller.abort(new Error("request timed out"));

    await expect(resultPromise).rejects.toThrow("request timed out");
    expect(sessionAbortCompactionMock).toHaveBeenCalledTimes(1);
  });
});

describe("compactEmbeddedPiSession hooks (ownsCompaction engine)", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    resolveContextEngineMock.mockReset();
    resolveContextEngineMock.mockResolvedValue({
      compact: contextEngineCompactMock,
      info: { ownsCompaction: true },
    });
    contextEngineCompactMock.mockReset();
    contextEngineCompactMock.mockResolvedValue({
      compacted: true,
      ok: true,
      reason: undefined,
      result: { summary: "engine-summary", tokensAfter: 50 },
    });
    mockResolvedModel();
  });

  it("fires before_compaction with sentinel -1 and after_compaction on success", async () => {
    hookRunner.hasHooks.mockReturnValue(true);

    const result = await compactEmbeddedPiSession(
      wrappedCompactionArgs({
        messageChannel: "telegram",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);

    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      { messageCount: -1, sessionFile: TEST_SESSION_FILE },
      expect.objectContaining({
        messageProvider: "telegram",
        sessionKey: TEST_SESSION_KEY,
      }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      {
        compactedCount: -1,
        messageCount: -1,
        sessionFile: TEST_SESSION_FILE,
        tokenCount: 50,
      },
      expect.objectContaining({
        messageProvider: "telegram",
        sessionKey: TEST_SESSION_KEY,
      }),
    );
  });

  it("emits a transcript update and post-compaction memory sync on the engine-owned path", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    try {
      const result = await compactEmbeddedPiSession(
        wrappedCompactionArgs({
          config: compactionConfig("await"),
          sessionFile: `  ${TEST_SESSION_FILE}  `,
        }),
      );

      expect(result.ok).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ sessionFile: TEST_SESSION_FILE });
      expect(sync).toHaveBeenCalledWith({
        reason: "post-compaction",
        sessionFiles: [TEST_SESSION_FILE],
      });
    } finally {
      cleanup();
    }
  });

  it("runs maintain after successful compaction with a transcript rewrite helper", async () => {
    const maintain = vi.fn(async (_params?: unknown) => ({
      bytesFreed: 0,
      changed: false,
      rewrittenEntries: 0,
    }));
    resolveContextEngineMock.mockResolvedValue({
      compact: contextEngineCompactMock,
      info: { ownsCompaction: true },
      maintain,
    } as never);

    const result = await compactEmbeddedPiSession(wrappedCompactionArgs());

    expect(result.ok).toBe(true);
    expect(maintain).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({
          workspaceDir: TEST_WORKSPACE_DIR,
        }),
        sessionFile: TEST_SESSION_FILE,
        sessionKey: TEST_SESSION_KEY,
      }),
    );
    const runtimeContext = (
      maintain.mock.calls[0]?.[0] as { runtimeContext?: Record<string, unknown> } | undefined
    )?.runtimeContext;
    expect(typeof runtimeContext?.rewriteTranscriptEntries).toBe("function");
  });

  it("resolves the effective compaction model before manual engine-owned compaction", async () => {
    await compactEmbeddedPiSession(
      wrappedCompactionArgs({
        authProfileId: "openai:p1",
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "anthropic/claude-opus-4-6",
              },
            },
          },
        },
        model: "gpt-5.4",
        provider: "openai-codex",
      }),
    );

    expect(resolveModelMock).toHaveBeenCalledWith(
      "anthropic",
      "claude-opus-4-6",
      expect.any(String),
      expect.anything(),
    );
    expect(contextEngineCompactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({
          authProfileId: undefined,
          model: "claude-opus-4-6",
          provider: "anthropic",
        }),
      }),
    );
  });

  it("does not fire after_compaction when compaction fails", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    contextEngineCompactMock.mockResolvedValue({
      compacted: false,
      ok: false,
      reason: "nothing to compact",
      result: undefined,
    });

    const result = await compactEmbeddedPiSession(wrappedCompactionArgs());

    expect(result.ok).toBe(false);
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalled();
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("does not duplicate transcript updates or sync in the wrapper when the engine delegates compaction", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    resolveContextEngineMock.mockResolvedValue({
      compact: contextEngineCompactMock,
      info: { ownsCompaction: false },
    });

    try {
      const result = await compactEmbeddedPiSession(
        wrappedCompactionArgs({
          config: compactionConfig("await"),
        }),
      );

      expect(result.ok).toBe(true);
      expect(listener).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("catches and logs hook exceptions without aborting compaction", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeCompaction.mockRejectedValue(new Error("hook boom"));

    const result = await compactEmbeddedPiSession(wrappedCompactionArgs());

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(contextEngineCompactMock).toHaveBeenCalled();
  });
});
