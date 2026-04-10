import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMemorySystemPromptAddition } from "../../../plugin-sdk/core.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptSection,
} from "../../../plugins/memory-state.js";
import {
  type AttemptContextEngine,
  assembleAttemptContextEngine,
  buildContextEnginePromptCacheInfo,
  finalizeAttemptContextEngineTurn,
  findCurrentAttemptAssistantMessage,
  runAttemptContextEngineBootstrap,
} from "./attempt.context-engine-helpers.js";
import {
  createContextEngineBootstrapAndAssemble,
  expectCalledWithSessionKey,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";
import {
  buildEmbeddedSubscriptionParams,
  cleanupEmbeddedAttemptResources,
} from "./attempt.subscription-cleanup.js";

const hoisted = getHoisted();
const embeddedSessionId = "embedded-session";
const sessionFile = "/tmp/session.jsonl";
const seedMessage = { content: "seed", role: "user", timestamp: 1 } as AgentMessage;
const doneMessage = { content: "done", role: "assistant", timestamp: 2 } as unknown as AgentMessage;
interface AfterTurnPromptCacheCall { runtimeContext?: { promptCache?: Record<string, unknown> } }

function createTestContextEngine(params: Partial<AttemptContextEngine>): AttemptContextEngine {
  return {
    compact: async () => ({
      compacted: false,
      ok: false,
      reason: "not used in this test",
    }),
    info: {
      id: "test-context-engine",
      name: "Test Context Engine",
      version: "0.0.1",
    },
    ingest: async () => ({ ingested: true }),
    ...params,
  } as AttemptContextEngine;
}

async function runBootstrap(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof runAttemptContextEngineBootstrap>[0]> = {},
) {
  await runAttemptContextEngineBootstrap({
    contextEngine,
    hadSessionFile: true,
    runMaintenance: hoisted.runContextEngineMaintenanceMock,
    runtimeContext: {},
    sessionFile,
    sessionId: embeddedSessionId,
    sessionKey,
    sessionManager: hoisted.sessionManager,
    warn: () => {},
    ...overrides,
  });
}

async function runAssemble(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof assembleAttemptContextEngine>[0]> = {},
) {
  return await assembleAttemptContextEngine({
    contextEngine,
    messages: [seedMessage],
    modelId: "gpt-test",
    sessionId: embeddedSessionId,
    sessionKey,
    tokenBudget: 2048,
    ...overrides,
  });
}

async function finalizeTurn(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof finalizeAttemptContextEngineTurn>[0]> = {},
) {
  await finalizeAttemptContextEngineTurn({
    aborted: false,
    contextEngine,
    messagesSnapshot: [doneMessage],
    prePromptMessageCount: 0,
    promptError: false,
    runMaintenance: hoisted.runContextEngineMaintenanceMock,
    runtimeContext: {},
    sessionFile,
    sessionIdUsed: embeddedSessionId,
    sessionKey,
    sessionManager: hoisted.sessionManager,
    tokenBudget: 2048,
    warn: () => {},
    yieldAborted: false,
    ...overrides,
  });
}

describe("runEmbeddedAttempt context engine sessionKey forwarding", () => {
  const sessionKey = "agent:main:discord:channel:test-ctx-engine";
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it("forwards sessionKey to bootstrap, assemble, and afterTurn", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async (_params: { sessionKey?: string }) => {});
    const contextEngine = createTestContextEngine({
      afterTurn,
      assemble,
      bootstrap,
    });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine);
    await finalizeTurn(sessionKey, contextEngine);

    expectCalledWithSessionKey(bootstrap, sessionKey);
    expectCalledWithSessionKey(assemble, sessionKey);
    expectCalledWithSessionKey(afterTurn, sessionKey);
  });

  it("forwards modelId to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ assemble, bootstrap });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine);

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
      }),
    );
  });

  it("forwards availableTools and citationsMode to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ assemble, bootstrap });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine, {
      availableTools: new Set(["memory_search", "wiki_search"]),
      citationsMode: "on",
    });

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        availableTools: new Set(["memory_search", "wiki_search"]),
        citationsMode: "on",
      }),
    );
  });

  it("lets non-legacy engines opt into the active memory prompt helper", async () => {
    registerMemoryPromptSection(({ availableTools, citationsMode }) => {
      if (!availableTools.has("memory_search")) {
        return [];
      }
      return [
        "## Memory Recall",
        `tools=${[...availableTools].toSorted().join(",")}`,
        `citations=${citationsMode ?? "auto"}`,
        "",
      ];
    });

    const contextEngine = createTestContextEngine({
      assemble: async ({ messages, availableTools, citationsMode }) => ({
        estimatedTokens: messages.length,
        messages,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      }),
    });

    const result = await runAssemble(sessionKey, contextEngine, {
      availableTools: new Set(["wiki_search", "memory_search"]),
      citationsMode: "on",
    });

    expect(result).toMatchObject({
      estimatedTokens: 1,
      systemPromptAddition: "## Memory Recall\ntools=memory_search,wiki_search\ncitations=on",
    });
  });

  it("forwards sessionKey to ingestBatch when afterTurn is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(
      async (_params: { sessionKey?: string; messages: AgentMessage[] }) => ({ ingestedCount: 1 }),
    );

    await finalizeTurn(sessionKey, createTestContextEngine({ assemble, bootstrap, ingestBatch }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expectCalledWithSessionKey(ingestBatch, sessionKey);
  });

  it("forwards sessionKey to per-message ingest when ingestBatch is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingest = vi.fn(async (_params: { sessionKey?: string; message: AgentMessage }) => ({
      ingested: true,
    }));

    await finalizeTurn(sessionKey, createTestContextEngine({ assemble, bootstrap, ingest }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expect(ingest).toHaveBeenCalled();
    expect(
      ingest.mock.calls.every((call) => {
        const params = call[0];
        return params.sessionKey === sessionKey;
      }),
    ).toBe(true);
  });

  it("forwards silentExpected to the embedded subscription", async () => {
    const params = buildEmbeddedSubscriptionParams({
      agentId: "main",
      blockReplyBreak: undefined,
      blockReplyChunking: undefined,
      config: undefined,
      enforceFinalTag: undefined,
      hookRunner: undefined,
      onAgentEvent: undefined,
      onAssistantMessageStart: undefined,
      onBlockReply: undefined,
      onBlockReplyFlush: undefined,
      onPartialReply: undefined,
      onReasoningEnd: undefined,
      onReasoningStream: undefined,
      onToolResult: undefined,
      reasoningMode: "off",
      runId: "run-context-engine-forwarding",
      session: {} as never,
      sessionId: embeddedSessionId,
      sessionKey,
      shouldEmitToolOutput: undefined,
      shouldEmitToolResult: undefined,
      silentExpected: true,
      toolResultFormat: undefined,
      verboseLevel: undefined,
    });

    expect(params.silentExpected).toBe(true);
    expect(params.sessionKey).toBe(sessionKey);
  });

  it("skips maintenance when afterTurn fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async () => {
      throw new Error("afterTurn failed");
    });

    await finalizeTurn(sessionKey, createTestContextEngine({ afterTurn, assemble, bootstrap }));

    expect(afterTurn).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });

  it("runs startup maintenance for existing sessions even without bootstrap()", async () => {
    const { assemble } = createContextEngineBootstrapAndAssemble();

    await runBootstrap(
      sessionKey,
      createTestContextEngine({
        assemble,
        maintain: async () => ({
          bytesFreed: 0,
          changed: false,
          reason: "test maintenance",
          rewrittenEntries: 0,
        }),
      }),
    );

    expect(hoisted.runContextEngineMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "bootstrap" }),
    );
  });

  it("builds prompt-cache retention, last-call usage, and cache-touch metadata", () => {
    expect(
      buildContextEnginePromptCacheInfo({
        lastCacheTouchAt: 123,
        lastCallUsage: {
          cacheRead: 40,
          cacheWrite: 2,
          input: 10,
          output: 5,
          total: 57,
        },
        retention: "short",
      }),
    ).toEqual(
      expect.objectContaining({
        lastCacheTouchAt: 123,
        lastCallUsage: {
          cacheRead: 40,
          cacheWrite: 2,
          input: 10,
          output: 5,
          total: 57,
        },
        retention: "short",
      }),
    );
  });

  it("omits prompt-cache metadata when no cache data is available", () => {
    expect(buildContextEnginePromptCacheInfo({})).toBeUndefined();
  });

  it("does not reuse a prior turn's usage when the current attempt has no assistant", () => {
    const priorAssistant = {
      content: "prior turn",
      role: "assistant",
      timestamp: 2,
      usage: {
        cacheRead: 1234,
        input: 99,
        output: 7,
        total: 1340,
      },
    } as unknown as AgentMessage;
    const currentAttemptAssistant = findCurrentAttemptAssistantMessage({
      messagesSnapshot: [seedMessage, priorAssistant],
      prePromptMessageCount: 2,
    });
    const promptCache = buildContextEnginePromptCacheInfo({
      lastCallUsage: (currentAttemptAssistant as { usage?: undefined } | undefined)?.usage,
      retention: "short",
    });

    expect(currentAttemptAssistant).toBeUndefined();
    expect(promptCache).toEqual({ retention: "short" });
  });

  it("threads prompt-cache break observations into afterTurn", async () => {
    const afterTurn = vi.fn(async (_params: AfterTurnPromptCacheCall) => {});

    await finalizeTurn(sessionKey, createTestContextEngine({ afterTurn }), {
      runtimeContext: {
        promptCache: {
          observation: {
            broke: true,
            cacheRead: 2000,
            changes: [{ code: "systemPrompt", detail: "system prompt digest changed" }],
            previousCacheRead: 5000,
          },
        },
      },
    });

    const afterTurnCall = afterTurn.mock.calls.at(0)?.[0];
    const runtimeContext = afterTurnCall?.runtimeContext;
    const observation = runtimeContext?.promptCache?.observation as
      | { broke?: boolean; previousCacheRead?: number; cacheRead?: number; changes?: unknown[] }
      | undefined;

    expect(observation).toEqual(
      expect.objectContaining({
        broke: true,
        cacheRead: 2000,
        changes: expect.arrayContaining([expect.objectContaining({ code: "systemPrompt" })]),
        previousCacheRead: 5000,
      }),
    );
  });

  it("skips maintenance when ingestBatch fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(async () => {
      throw new Error("ingestBatch failed");
    });

    await finalizeTurn(sessionKey, createTestContextEngine({ assemble, bootstrap, ingestBatch }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expect(ingestBatch).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });

  it("releases the session lock even when teardown cleanup throws", async () => {
    const releaseMock = vi.fn(async () => {});
    const disposeMock = vi.fn();
    const flushMock = vi.fn(async () => {
      throw new Error("flush failed");
    });

    await cleanupEmbeddedAttemptResources({
      bundleLspRuntime: undefined,
      flushPendingToolResultsAfterIdle: flushMock,
      releaseWsSession: hoisted.releaseWsSessionMock,
      removeToolResultContextGuard: () => {},
      session: { agent: {}, dispose: disposeMock },
      sessionId: embeddedSessionId,
      sessionLock: { release: releaseMock },
      sessionManager: hoisted.sessionManager,
    });

    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseWsSessionMock).toHaveBeenCalledWith("embedded-session");
  });
});
