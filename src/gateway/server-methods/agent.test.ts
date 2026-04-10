import { afterEach, describe, expect, it, vi } from "vitest";
import { BARE_SESSION_RESET_PROMPT } from "../../auto-reply/reply/session-reset-prompt.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { agentHandlers } from "./agent.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

const mocks = vi.hoisted(() => ({
  agentCommand: vi.fn(),
  getLatestSubagentRunByChildSessionKey: vi.fn(),
  loadConfigReturn: {} as Record<string, unknown>,
  loadGatewaySessionRow: vi.fn(),
  loadSessionEntry: vi.fn(),
  performGatewaySessionReset: vi.fn(),
  registerAgentRunContext: vi.fn(),
  replaceSubagentRunAfterSteer: vi.fn(),
  updateSessionStore: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadGatewaySessionRow: mocks.loadGatewaySessionRow,
    loadSessionEntry: mocks.loadSessionEntry,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    resolveAgentIdFromSessionKey: () => "main",
    resolveAgentMainSessionKey: ({
      cfg,
      agentId,
    }: {
      cfg?: { session?: { mainKey?: string } };
      agentId: string;
    }) => `agent:${agentId}:${cfg?.session?.mainKey ?? "main"}`,
    resolveExplicitAgentSessionKey: () => undefined,
    updateSessionStore: mocks.updateSessionStore,
  };
});

vi.mock("../../commands/agent.js", () => ({
  agentCommand: mocks.agentCommand,
  agentCommandFromIngress: mocks.agentCommand,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => mocks.loadConfigReturn,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
}));

vi.mock("../../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(),
  registerAgentRunContext: mocks.registerAgentRunContext,
}));

vi.mock("../../agents/subagent-registry-read.js", () => ({
  getLatestSubagentRunByChildSessionKey: mocks.getLatestSubagentRunByChildSessionKey,
}));

vi.mock("../session-subagent-reactivation.runtime.js", () => ({
  replaceSubagentRunAfterSteer: mocks.replaceSubagentRunAfterSteer,
}));

vi.mock("../session-reset-service.js", () => ({
  performGatewaySessionReset: (...args: unknown[]) =>
    (mocks.performGatewaySessionReset as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => "allow",
}));

vi.mock("../../utils/delivery-context.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/delivery-context.js")>(
    "../../utils/delivery-context.js",
  );
  return {
    ...actual,
    normalizeSessionDeliveryFields: () => ({}),
  };
});

const makeContext = (): GatewayRequestContext =>
  ({
    addChatRun: vi.fn(),
    broadcastToConnIds: vi.fn(),
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => new Set(),
    logGateway: { error: vi.fn(), info: vi.fn() },
  }) as unknown as GatewayRequestContext;

type AgentHandlerArgs = Parameters<typeof agentHandlers.agent>[0];
type AgentParams = AgentHandlerArgs["params"];

type AgentIdentityGetHandlerArgs = Parameters<(typeof agentHandlers)["agent.identity.get"]>[0];
type AgentIdentityGetParams = AgentIdentityGetHandlerArgs["params"];

async function waitForAssertion(assertion: () => void, timeoutMs = 2000, stepMs = 5) {
  vi.useFakeTimers();
  try {
    let lastError: unknown;
    for (let elapsed = 0; elapsed <= timeoutMs; elapsed += stepMs) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
      }
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(stepMs);
    }
    throw lastError ?? new Error("assertion did not pass in time");
  } finally {
    vi.useRealTimers();
  }
}

function mockMainSessionEntry(entry: Record<string, unknown>, cfg: Record<string, unknown> = {}) {
  mocks.loadSessionEntry.mockReturnValue({
    canonicalKey: "agent:main:main",
    cfg,
    entry: {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      ...entry,
    },
    storePath: "/tmp/sessions.json",
  });
}

function buildExistingMainStoreEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "existing-session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function setupNewYorkTimeConfig(isoDate: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoDate)); // Wed Jan 28, 8:30 PM EST
  mocks.agentCommand.mockClear();
  mocks.loadConfigReturn = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
      },
    },
  };
}

function resetTimeConfig() {
  mocks.loadConfigReturn = {};
  vi.useRealTimers();
}

async function expectResetCall(expectedMessage: string) {
  await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
  expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
  const call = readLastAgentCommandCall();
  expect(call?.message).toBe(expectedMessage);
  return call;
}

function primeMainAgentRun(params?: { sessionId?: string; cfg?: Record<string, unknown> }) {
  mockMainSessionEntry(
    { sessionId: params?.sessionId ?? "existing-session-id" },
    params?.cfg ?? {},
  );
  mocks.updateSessionStore.mockResolvedValue(undefined);
  mocks.agentCommand.mockResolvedValue({
    meta: { durationMs: 100 },
    payloads: [{ text: "ok" }],
  });
}

async function runMainAgent(message: string, idempotencyKey: string) {
  const respond = vi.fn();
  await invokeAgent(
    {
      agentId: "main",
      idempotencyKey,
      message,
      sessionKey: "agent:main:main",
    },
    { reqId: idempotencyKey, respond },
  );
  return respond;
}

async function runMainAgentAndCaptureEntry(idempotencyKey: string) {
  const loaded = mocks.loadSessionEntry();
  const canonicalKey = loaded?.canonicalKey ?? "agent:main:main";
  const existingEntry = structuredClone(loaded?.entry ?? buildExistingMainStoreEntry());
  let capturedEntry: Record<string, unknown> | undefined;
  mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
    const store: Record<string, unknown> = {
      [canonicalKey]: existingEntry,
    };
    const result = await updater(store);
    capturedEntry = result as Record<string, unknown>;
    return result;
  });
  mocks.agentCommand.mockResolvedValue({
    meta: { durationMs: 100 },
    payloads: [{ text: "ok" }],
  });
  await runMainAgent("hi", idempotencyKey);
  return capturedEntry;
}

function readLastAgentCommandCall():
  | {
      message?: string;
      sessionId?: string;
    }
  | undefined {
  return mocks.agentCommand.mock.calls.at(-1)?.[0] as
    | { message?: string; sessionId?: string }
    | undefined;
}

function mockSessionResetSuccess(params: {
  reason: "new" | "reset";
  key?: string;
  sessionId?: string;
}) {
  const key = params.key ?? "agent:main:main";
  const sessionId = params.sessionId ?? "reset-session-id";
  mocks.performGatewaySessionReset.mockImplementation(
    async (opts: { key: string; reason: string; commandSource: string }) => {
      expect(opts.key).toBe(key);
      expect(opts.reason).toBe(params.reason);
      expect(opts.commandSource).toBe("gateway:agent");
      return {
        entry: { sessionId },
        key,
        ok: true,
      };
    },
  );
}

async function invokeAgent(
  params: AgentParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
    client?: AgentHandlerArgs["client"];
    isWebchatConnect?: AgentHandlerArgs["isWebchatConnect"];
  },
) {
  const respond = options?.respond ?? vi.fn();
  await agentHandlers.agent({
    client: options?.client ?? null,
    context: options?.context ?? makeContext(),
    isWebchatConnect: options?.isWebchatConnect ?? (() => false),
    params,
    req: { id: options?.reqId ?? "agent-test-req", method: "agent", type: "req" },
    respond: respond as never,
  });
  return respond;
}

async function invokeAgentIdentityGet(
  params: AgentIdentityGetParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
  },
) {
  const respond = options?.respond ?? vi.fn();
  await agentHandlers["agent.identity.get"]({
    client: null,
    context: options?.context ?? makeContext(),
    isWebchatConnect: () => false,
    params,
    req: {
      id: options?.reqId ?? "agent-identity-test-req",
      method: "agent.identity.get",
      type: "req",
    },
    respond: respond as never,
  });
  return respond;
}

describe("gateway agent handler", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryForTests();
  });

  it("preserves ACP metadata from the current stored session entry", async () => {
    const existingAcpMeta = {
      agent: "codex",
      backend: "acpx",
      lastActivityAt: Date.now(),
      mode: "persistent",
      runtimeSessionName: "runtime-1",
      state: "idle",
    };

    mockMainSessionEntry({
      acp: existingAcpMeta,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({ acp: existingAcpMeta }),
      };
      const result = await updater(store);
      capturedEntry = store["agent:main:main"] as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      meta: { durationMs: 100 },
      payloads: [{ text: "ok" }],
    });

    await runMainAgent("test", "test-idem-acp-meta");

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.acp).toEqual(existingAcpMeta);
  });

  it("forwards provider and model overrides for admin-scoped callers", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        agentId: "main",
        idempotencyKey: "test-idem-model-override",
        message: "test override",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        sessionKey: "agent:main:main",
      },
      {
        client: {
          connect: {
            scopes: ["operator.admin"],
          },
        } as AgentHandlerArgs["client"],
        reqId: "test-idem-model-override",
      },
    );

    const lastCall = mocks.agentCommand.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(
      expect.objectContaining({
        model: "claude-haiku-4-5",
        provider: "anthropic",
      }),
    );
  });

  it("rejects provider and model overrides for write-scoped callers", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        agentId: "main",
        idempotencyKey: "test-idem-model-override-write",
        message: "test override",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        sessionKey: "agent:main:main",
      },
      {
        client: {
          connect: {
            scopes: ["operator.write"],
          },
        } as AgentHandlerArgs["client"],
        reqId: "test-idem-model-override-write",
        respond,
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "provider/model overrides are not authorized for this caller.",
      }),
    );
  });

  it("forwards provider and model overrides when internal override authorization is set", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        agentId: "main",
        idempotencyKey: "test-idem-model-override-internal",
        message: "test override",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        sessionKey: "agent:main:main",
      },
      {
        client: {
          connect: {
            scopes: ["operator.write"],
          },
          internal: {
            allowModelOverride: true,
          },
        } as AgentHandlerArgs["client"],
        reqId: "test-idem-model-override-internal",
      },
    );

    const lastCall = mocks.agentCommand.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(
      expect.objectContaining({
        model: "claude-haiku-4-5",
        provider: "anthropic",
        senderIsOwner: false,
      }),
    );
  });

  it("preserves cliSessionIds from existing session entry", async () => {
    const existingCliSessionIds = { "claude-cli": "abc-123-def" };
    const existingClaudeCliSessionId = "abc-123-def";

    mockMainSessionEntry({
      claudeCliSessionId: existingClaudeCliSessionId,
      cliSessionIds: existingCliSessionIds,
    });

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem");
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.cliSessionIds).toEqual(existingCliSessionIds);
    expect(capturedEntry?.claudeCliSessionId).toBe(existingClaudeCliSessionId);
  });
  it("reactivates completed subagent sessions and broadcasts send updates", async () => {
    const childSessionKey = "agent:main:subagent:followup";
    const completedRun = {
      childSessionKey,
      cleanup: "keep" as const,
      controllerSessionKey: "agent:main:main",
      createdAt: 1,
      endedAt: 3,
      outcome: { status: "ok" as const },
      ownerKey: "agent:main:main",
      requesterDisplayKey: "main",
      runId: "run-old",
      scopeKind: "session",
      startedAt: 2,
      task: "initial task",
    };

    mocks.loadSessionEntry.mockReturnValue({
      canonicalKey: childSessionKey,
      cfg: {},
      entry: {
        sessionId: "sess-followup",
        updatedAt: Date.now(),
      },
      storePath: "/tmp/sessions.json",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [childSessionKey]: {
          sessionId: "sess-followup",
          updatedAt: Date.now(),
        },
      };
      return await updater(store);
    });
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(completedRun);
    mocks.replaceSubagentRunAfterSteer.mockReturnValueOnce(true);
    mocks.loadGatewaySessionRow.mockReturnValueOnce({
      endedAt: undefined,
      runtimeMs: 10,
      startedAt: 123,
      status: "running",
    });
    mocks.agentCommand.mockResolvedValue({
      meta: { durationMs: 100 },
      payloads: [{ text: "ok" }],
    });

    const respond = vi.fn();
    const broadcastToConnIds = vi.fn();
    await invokeAgent(
      {
        idempotencyKey: "run-new",
        message: "follow-up",
        sessionKey: childSessionKey,
      },
      {
        context: {
          addChatRun: vi.fn(),
          broadcastToConnIds,
          dedupe: new Map(),
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          logGateway: { error: vi.fn(), info: vi.fn() },
        } as unknown as GatewayRequestContext,
        respond,
      },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "run-new",
        status: "accepted",
      }),
      undefined,
      { runId: "run-new" },
    );
    expectSubagentFollowupReactivation({
      broadcastToConnIds,
      childSessionKey,
      completedRun,
      replaceSubagentRunAfterSteerMock: mocks.replaceSubagentRunAfterSteer,
    });
  });

  it("includes live session setting metadata in agent send events", async () => {
    mockMainSessionEntry({
      fastMode: true,
      lastAccountId: "acct-1",
      lastChannel: "telegram",
      lastThreadId: 42,
      lastTo: "-100123",
      sendPolicy: "deny",
      sessionId: "sess-main",
      updatedAt: Date.now(),
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          fastMode: true,
          lastAccountId: "acct-1",
          lastChannel: "telegram",
          lastThreadId: 42,
          lastTo: "-100123",
          sendPolicy: "deny",
        }),
      };
      return await updater(store);
    });
    mocks.loadGatewaySessionRow.mockReturnValue({
      fastMode: true,
      forkedFromParent: true,
      lastAccountId: "acct-1",
      lastChannel: "telegram",
      lastThreadId: 42,
      lastTo: "-100123",
      sendPolicy: "deny",
      spawnDepth: 2,
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      status: "running",
      subagentControlScope: "children",
      subagentRole: "orchestrator",
      totalTokens: 12,
    });
    mocks.agentCommand.mockResolvedValue({
      meta: { durationMs: 100 },
      payloads: [{ text: "ok" }],
    });

    const broadcastToConnIds = vi.fn();
    await invokeAgent(
      {
        idempotencyKey: "test-live-settings",
        message: "test",
        sessionKey: "agent:main:main",
      },
      {
        context: {
          addChatRun: vi.fn(),
          broadcastToConnIds,
          dedupe: new Map(),
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          logGateway: { error: vi.fn(), info: vi.fn() },
        } as unknown as GatewayRequestContext,
      },
    );

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        fastMode: true,
        forkedFromParent: true,
        lastAccountId: "acct-1",
        lastChannel: "telegram",
        lastThreadId: 42,
        lastTo: "-100123",
        reason: "send",
        sendPolicy: "deny",
        sessionKey: "agent:main:main",
        spawnDepth: 2,
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent",
        status: "running",
        subagentControlScope: "children",
        subagentRole: "orchestrator",
        totalTokens: 12,
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  it("injects a timestamp into the message passed to agentCommand", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");

    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        agentId: "main",
        idempotencyKey: "test-timestamp-inject",
        message: "Is it the weekend?",
        sessionKey: "agent:main:main",
      },
      { reqId: "ts-1" },
    );

    // Wait for the async agentCommand call
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());

    const callArgs = mocks.agentCommand.mock.calls[0][0];
    expect(callArgs.message).toBe("[Wed 2026-01-28 20:30 EST] Is it the weekend?");

    resetTimeConfig();
  });

  it.each([
    {
      idempotencyKey: "test-sender-owner-write",
      name: "passes senderIsOwner=false for write-scoped gateway callers",
      scopes: ["operator.write"],
      senderIsOwner: false,
    },
    {
      idempotencyKey: "test-sender-owner-admin",
      name: "passes senderIsOwner=true for admin-scoped gateway callers",
      scopes: ["operator.admin"],
      senderIsOwner: true,
    },
  ])("$name", async ({ scopes, idempotencyKey, senderIsOwner }) => {
    primeMainAgentRun();

    await invokeAgent(
      {
        idempotencyKey,
        message: "owner-tools check",
        sessionKey: "agent:main:main",
      },
      {
        client: {
          connect: {
            client: { id: "test-client", mode: "gateway" },
            role: "operator",
            scopes,
          },
        } as unknown as AgentHandlerArgs["client"],
      },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(callArgs?.senderIsOwner).toBe(senderIsOwner);
  });

  it("respects explicit bestEffortDeliver=false for main session runs", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();

    await invokeAgent(
      {
        agentId: "main",
        bestEffortDeliver: false,
        deliver: true,
        idempotencyKey: "test-strict-delivery",
        message: "strict delivery",
        replyChannel: "telegram",
        sessionKey: "agent:main:main",
        to: "123",
      },
      { reqId: "strict-1" },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(callArgs.bestEffortDeliver).toBe(false);
  });

  it("downgrades to session-only when bestEffortDeliver=true and no external channel is configured", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();
    const respond = vi.fn();
    const logInfo = vi.fn();

    await invokeAgent(
      {
        agentId: "main",
        bestEffortDeliver: true,
        deliver: true,
        idempotencyKey: "test-best-effort-delivery-fallback",
        message: "best effort delivery fallback",
        sessionKey: "agent:main:main",
      },
      {
        context: {
          addChatRun: vi.fn(),
          broadcastToConnIds: vi.fn(),
          dedupe: new Map(),
          getSessionEventSubscriberConnIds: () => new Set(),
          logGateway: { error: vi.fn(), info: logInfo },
        } as unknown as GatewayRequestContext,
        reqId: "best-effort-delivery-fallback",
        respond,
      },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const accepted = respond.mock.calls.find(
      (call: unknown[]) =>
        call[0] === true && (call[1] as Record<string, unknown>)?.status === "accepted",
    );
    expect(accepted).toBeDefined();
    const rejected = respond.mock.calls.find((call: unknown[]) => call[0] === false);
    expect(rejected).toBeUndefined();
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(
      expect.stringContaining("agent delivery downgraded to session-only (bestEffortDeliver)"),
    );
  });

  it("rejects public spawned-run metadata fields", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        idempotencyKey: "workspace-rejected",
        message: "spawned run",
        sessionKey: "agent:main:main",
        spawnedBy: "agent:main:subagent:parent",
        workspaceDir: "/tmp/injected",
      } as AgentParams,
      { reqId: "workspace-rejected-1", respond },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid agent params"),
      }),
    );
  });

  it("accepts music generation internal events", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        idempotencyKey: "music-generation-event",
        internalEvents: [
          {
            announceType: "music generation task",
            childSessionId: "task-123",
            childSessionKey: "music:task-123",
            replyInstruction: "Reply in your normal assistant voice now.",
            result: "MEDIA: https://example.test/song.mp3",
            source: "music_generation",
            status: "ok",
            statusLabel: "completed successfully",
            taskLabel: "compose a loop",
            type: "task_completion",
          },
        ],
        message: "music generation finished",
        sessionKey: "agent:main:main",
      },
      { reqId: "music-generation-event-1", respond },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    expect(respond).not.toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid agent params"),
      }),
    );
  });

  it("does not create task rows for inter-session completion wakes", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        idempotencyKey: "music-generation-event-inter-session",
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "internal",
          sourceSessionKey: "music_generate:task-123",
          sourceTool: "music_generate",
        },
        internalEvents: [
          {
            announceType: "music generation task",
            childSessionId: "task-123",
            childSessionKey: "music:task-123",
            replyInstruction: "Reply in your normal assistant voice now.",
            result: "MEDIA:/tmp/song.mp3",
            source: "music_generation",
            status: "ok",
            statusLabel: "completed successfully",
            taskLabel: "compose a loop",
            type: "task_completion",
          },
        ],
        message: [
          "[Mon 2026-04-06 02:42 GMT+1] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
        ].join("\n"),
        sessionKey: "agent:main:main",
      },
      { reqId: "music-generation-event-inter-session" },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    expect(findTaskByRunId("music-generation-event-inter-session")).toBeUndefined();
  });

  it("only forwards workspaceDir for spawned sessions with stored workspace inheritance", async () => {
    primeMainAgentRun();
    mockMainSessionEntry({
      spawnedBy: "agent:main:subagent:parent",
      spawnedWorkspaceDir: "/tmp/inherited",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          spawnedBy: "agent:main:subagent:parent",
          spawnedWorkspaceDir: "/tmp/inherited",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        idempotencyKey: "workspace-forwarded",
        message: "spawned run",
        sessionKey: "agent:main:main",
      },
      { reqId: "workspace-forwarded-1" },
    );
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const spawnedCall = mocks.agentCommand.mock.calls.at(-1)?.[0] as { workspaceDir?: string };
    expect(spawnedCall.workspaceDir).toBe("/tmp/inherited");
  });

  it("keeps origin messageChannel as webchat while delivery channel uses last session channel", async () => {
    mockMainSessionEntry({
      lastChannel: "telegram",
      lastTo: "12345",
      sessionId: "existing-session-id",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "12345",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      meta: { durationMs: 100 },
      payloads: [{ text: "ok" }],
    });

    await invokeAgent(
      {
        idempotencyKey: "test-webchat-origin-channel",
        message: "webchat turn",
        sessionKey: "agent:main:main",
      },
      {
        client: {
          connect: {
            client: { id: "webchat-ui", mode: "webchat" },
          },
        } as AgentHandlerArgs["client"],
        isWebchatConnect: () => true,
        reqId: "webchat-origin-1",
      },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as {
      channel?: string;
      messageChannel?: string;
      runContext?: { messageChannel?: string };
    };
    expect(callArgs.channel).toBe("telegram");
    expect(callArgs.messageChannel).toBe("webchat");
    expect(callArgs.runContext?.messageChannel).toBe("webchat");
  });

  it("tracks async gateway agent runs in the shared task registry", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      primeMainAgentRun();

      await invokeAgent(
        {
          idempotencyKey: "task-registry-agent-run",
          message: "background cli task",
          sessionKey: "agent:main:main",
        },
        { reqId: "task-registry-agent-run" },
      );

      expect(findTaskByRunId("task-registry-agent-run")).toMatchObject({
        childSessionKey: "agent:main:main",
        runtime: "cli",
        status: "running",
      });
    });
  });

  it("handles missing cliSessionIds gracefully", async () => {
    mockMainSessionEntry({});

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-2");
    expect(capturedEntry).toBeDefined();
    // Should be undefined, not cause an error
    expect(capturedEntry?.cliSessionIds).toBeUndefined();
    expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
  });
  it("prunes legacy main alias keys when writing a canonical session entry", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:work",
      cfg: {
        agents: { list: [{ default: true, id: "main" }] },
        session: { mainKey: "work" },
      },
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
      },
      storePath: "/tmp/sessions.json",
    });

    let capturedStore: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:MAIN": { sessionId: "legacy-session-id", updatedAt: 5 },
        "agent:main:work": { sessionId: "existing-session-id", updatedAt: 10 },
      };
      await updater(store);
      capturedStore = store;
    });

    mocks.agentCommand.mockResolvedValue({
      meta: { durationMs: 100 },
      payloads: [{ text: "ok" }],
    });

    await invokeAgent(
      {
        agentId: "main",
        idempotencyKey: "test-idem-alias-prune",
        message: "test",
        sessionKey: "main",
      },
      { reqId: "3" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedStore).toBeDefined();
    expect(capturedStore?.["agent:main:work"]).toBeDefined();
    expect(capturedStore?.["agent:main:MAIN"]).toBeUndefined();
  });

  it("handles bare /new by resetting the same session and sending reset greeting prompt", async () => {
    mockSessionResetSuccess({ reason: "new" });

    primeMainAgentRun({ sessionId: "reset-session-id" });

    await invokeAgent(
      {
        idempotencyKey: "test-idem-new",
        message: "/new",
        sessionKey: "agent:main:main",
      },
      {
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
        reqId: "4",
      },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    const call = readLastAgentCommandCall();
    // Message is now dynamically built with current date — check key substrings
    expect(call?.message).toContain("Run your Session Startup sequence");
    expect(call?.message).toContain("Current time:");
    expect(call?.message).not.toBe(BARE_SESSION_RESET_PROMPT);
    expect(call?.sessionId).toBe("reset-session-id");
  });

  it("uses /reset suffix as the post-reset message and still injects timestamp", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    mockSessionResetSuccess({ reason: "reset" });
    mocks.performGatewaySessionReset.mockClear();
    primeMainAgentRun({
      cfg: mocks.loadConfigReturn,
      sessionId: "reset-session-id",
    });

    await invokeAgent(
      {
        idempotencyKey: "test-idem-reset-suffix",
        message: "/reset check status",
        sessionKey: "agent:main:main",
      },
      {
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
        reqId: "4b",
      },
    );

    const call = await expectResetCall("[Wed 2026-01-28 20:30 EST] check status");
    expect(call?.sessionId).toBe("reset-session-id");

    resetTimeConfig();
  });

  it("rejects malformed agent session keys early in agent handler", async () => {
    mocks.agentCommand.mockClear();
    const respond = await invokeAgent(
      {
        idempotencyKey: "test-malformed-session-key",
        message: "test",
        sessionKey: "agent:main",
      },
      { reqId: "4" },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed session key"),
      }),
    );
  });

  it("rejects /reset for write-scoped gateway callers", async () => {
    mockMainSessionEntry({ sessionId: "existing-session-id" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        idempotencyKey: "test-reset-write-scope",
        message: "/reset",
        sessionKey: "agent:main:main",
      },
      {
        client: { connect: { scopes: ["operator.write"] } } as AgentHandlerArgs["client"],
        reqId: "4c",
      },
    );

    expect(mocks.performGatewaySessionReset).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "missing scope: operator.admin",
      }),
    );
  });

  it("rejects malformed session keys in agent.identity.get", async () => {
    const respond = await invokeAgentIdentityGet(
      {
        sessionKey: "agent:main",
      },
      { reqId: "5" },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed session key"),
      }),
    );
  });
});
