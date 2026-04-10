import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";

interface AgentCallRequest {
  method?: string;
  params?: Record<string, unknown>;
}

const agentSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const callGatewayMock = vi.fn(async (_request: unknown) => ({}));
const loadSessionStoreMock = vi.fn((_storePath: string) => ({}));
const resolveAgentIdFromSessionKeyMock = vi.fn(
  (sessionKey: string) => sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main",
);
const resolveStorePathMock = vi.fn((_store: unknown, _options: unknown) => "/tmp/sessions.json");
const resolveMainSessionKeyMock = vi.fn((_cfg: unknown) => "agent:main:main");
const readLatestAssistantReplyMock = vi.fn(async (_params?: unknown) => "raw subagent reply");
const isEmbeddedPiRunActiveMock = vi.fn((_sessionId: string) => false);
const queueEmbeddedPiMessageMock = vi.fn((_sessionId: string, _text: string) => false);
const waitForEmbeddedPiRunEndMock = vi.fn(async (_sessionId: string, _timeoutMs?: number) => true);
let mockConfig: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

const { subagentRegistryRuntimeMock } = vi.hoisted(() => ({
  subagentRegistryRuntimeMock: {
    countActiveDescendantRuns: vi.fn(() => 0),
    countPendingDescendantRuns: vi.fn(() => 0),
    countPendingDescendantRunsExcludingRun: vi.fn(() => 0),
    isSubagentSessionRunActive: vi.fn(() => true),
    listSubagentRunsForRequester: vi.fn(() => []),
    replaceSubagentRunAfterSteer: vi.fn(() => true),
    resolveRequesterForChildSession: vi.fn(() => null),
    shouldIgnorePostCompletionAnnounceForSession: vi.fn(() => false),
  },
}));

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: (request: unknown) => callGatewayMock(request),
  isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActiveMock(sessionId),
  loadConfig: () => mockConfig,
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
  queueEmbeddedPiMessage: (sessionId: string, text: string) =>
    queueEmbeddedPiMessageMock(sessionId, text),
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    resolveAgentIdFromSessionKeyMock(sessionKey),
  resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
  resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
  waitForEmbeddedPiRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedPiRunEndMock(sessionId, timeoutMs),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: (params?: unknown) => readLatestAssistantReplyMock(params),
}));

vi.mock("./subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: (request: unknown) => callGatewayMock(request),
    isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActiveMock(sessionId),
    loadConfig: () => mockConfig,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    queueEmbeddedPiMessage: (sessionId: string, text: string) =>
      queueEmbeddedPiMessageMock(sessionId, text),
    resolveAgentIdFromSessionKey: (sessionKey: string) =>
      resolveAgentIdFromSessionKeyMock(sessionKey),
    resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
    resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
  }),
);

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: async (params: {
    targetRequesterSessionKey: string;
    triggerMessage: string;
    requesterIsSubagent?: boolean;
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string };
    completionDirectOrigin?: {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string;
    };
    directOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string };
    requesterSessionOrigin?: { provider?: string; channel?: string };
    bestEffortDeliver?: boolean;
  }) => {
    const store = loadSessionStoreMock("/tmp/sessions.json") as Record<string, unknown>;
    const requesterEntry = (store?.[params.targetRequesterSessionKey] ?? {}) as
      | { sessionId?: string; origin?: { provider?: string; channel?: string } }
      | undefined;
    const sessionId = requesterEntry?.sessionId?.trim();
    const queueChannel =
      requesterEntry?.origin?.provider ??
      requesterEntry?.origin?.channel ??
      params.requesterSessionOrigin?.provider ??
      params.requesterSessionOrigin?.channel;

    if (sessionId && queueChannel === "discord" && isEmbeddedPiRunActiveMock(sessionId)) {
      queueEmbeddedPiMessageMock(
        sessionId,
        `[Internal task completion event]\n${params.triggerMessage}`,
      );
      return { delivered: true, path: "queue" };
    }

    const effectiveOrigin =
      params.completionDirectOrigin ?? params.requesterOrigin ?? params.directOrigin;

    await callGatewayMock({
      method: "agent",
      params: {
        bestEffortDeliver: params.bestEffortDeliver,
        deliver:
          !params.requesterIsSubagent &&
          effectiveOrigin?.channel !== "webchat" &&
          Boolean(effectiveOrigin?.channel && effectiveOrigin?.to),
        message: params.triggerMessage,
        sessionKey: params.targetRequesterSessionKey,
        ...(params.requesterIsSubagent
          ? {}
          : {
              accountId: effectiveOrigin?.accountId,
              channel: effectiveOrigin?.channel,
              threadId: effectiveOrigin?.threadId,
              to: effectiveOrigin?.to,
            }),
      },
    });

    return { delivered: true, path: "direct" };
  },
  loadRequesterSessionEntry: (sessionKey: string) => {
    const store = loadSessionStoreMock("/tmp/sessions.json") as Record<string, unknown>;
    const entry = store?.[sessionKey];
    return { entry };
  },
  loadSessionEntryByKey: (sessionKey: string) => {
    const store = loadSessionStoreMock("/tmp/sessions.json") as Record<string, unknown>;
    return store?.[sessionKey] ?? { sessionId: sessionKey };
  },
  resolveAnnounceOrigin: (
    entry:
      | {
          lastChannel?: string;
          lastTo?: string;
          lastAccountId?: string;
          lastThreadId?: string;
          origin?: { provider?: string; channel?: string; accountId?: string };
        }
      | undefined,
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string },
  ) => ({
    accountId: requesterOrigin?.accountId ?? entry?.lastAccountId ?? entry?.origin?.accountId,
    channel:
      requesterOrigin?.channel ??
      entry?.lastChannel ??
      entry?.origin?.provider ??
      entry?.origin?.channel,
    threadId: requesterOrigin?.threadId ?? entry?.lastThreadId,
    to: requesterOrigin?.to ?? entry?.lastTo,
  }),
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
}));

vi.mock("./subagent-announce.registry.runtime.js", () => subagentRegistryRuntimeMock);
import { runSubagentAnnounceFlow } from "./subagent-announce.js";

describe("subagent announce seam flow", () => {
  beforeEach(() => {
    agentSpy.mockClear();
    sessionsDeleteSpy.mockClear();
    callGatewayMock.mockReset().mockImplementation(async (req: unknown) => {
      const typed = req as AgentCallRequest;
      if (typed.method === "agent") {
        return await agentSpy(typed);
      }
      if (typed.method === "agent.wait") {
        return { endedAt: 20, startedAt: 10, status: "ok" };
      }
      if (typed.method === "chat.history") {
        return { messages: [] as unknown[] };
      }
      if (typed.method === "sessions.patch") {
        return {};
      }
      if (typed.method === "sessions.delete") {
        sessionsDeleteSpy(typed);
        return {};
      }
      return {};
    });
    loadSessionStoreMock.mockReset().mockImplementation(() => ({}));
    resolveAgentIdFromSessionKeyMock.mockReset().mockImplementation(() => "main");
    resolveStorePathMock.mockReset().mockImplementation(() => "/tmp/sessions.json");
    resolveMainSessionKeyMock.mockReset().mockImplementation(() => "agent:main:main");
    readLatestAssistantReplyMock.mockReset().mockResolvedValue("raw subagent reply");
    isEmbeddedPiRunActiveMock.mockReset().mockReturnValue(false);
    queueEmbeddedPiMessageMock.mockReset().mockReturnValue(false);
    waitForEmbeddedPiRunEndMock.mockReset().mockResolvedValue(true);
    mockConfig = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
    subagentRegistryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockReset();
    subagentRegistryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockReturnValue(false);
    subagentRegistryRuntimeMock.isSubagentSessionRunActive.mockReset();
    subagentRegistryRuntimeMock.isSubagentSessionRunActive.mockReturnValue(true);
    subagentRegistryRuntimeMock.countActiveDescendantRuns.mockReset();
    subagentRegistryRuntimeMock.countActiveDescendantRuns.mockReturnValue(0);
    subagentRegistryRuntimeMock.countPendingDescendantRuns.mockReset();
    subagentRegistryRuntimeMock.countPendingDescendantRuns.mockReturnValue(0);
    subagentRegistryRuntimeMock.countPendingDescendantRunsExcludingRun.mockReset();
    subagentRegistryRuntimeMock.countPendingDescendantRunsExcludingRun.mockReturnValue(0);
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReset();
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([]);
    subagentRegistryRuntimeMock.replaceSubagentRunAfterSteer.mockReset();
    subagentRegistryRuntimeMock.replaceSubagentRunAfterSteer.mockReturnValue(true);
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReset();
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReturnValue(null);
  });

  it("suppresses ANNOUNCE_SKIP delivery while still deleting the child session", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childRunId: "run-direct-skip-whitespace",
      childSessionKey: "agent:main:subagent:test",
      cleanup: "delete",
      endedAt: 20,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      roundOneReply: "  ANNOUNCE_SKIP  ",
      startedAt: 10,
      task: "do thing",
      timeoutMs: 10,
      waitForCompletion: false,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sessionsDeleteSpy).toHaveBeenCalledTimes(1);
    expect(sessionsDeleteSpy).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        deleteTranscript: true,
        emitLifecycleHooks: false,
        key: "agent:main:subagent:test",
      },
      timeoutMs: 10_000,
    });
  });

  it("keeps lifecycle hooks enabled when deleting a completed session-mode child session", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childRunId: "run-session-delete-cleanup",
      childSessionKey: "agent:main:subagent:test",
      cleanup: "delete",
      endedAt: 20,
      expectsCompletionMessage: true,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      roundOneReply: "completed",
      spawnMode: "session",
      startedAt: 10,
      task: "thread-bound cleanup",
      timeoutMs: 10,
      waitForCompletion: false,
    });

    expect(didAnnounce).toBe(true);
    expect(sessionsDeleteSpy).toHaveBeenCalledTimes(1);
    expect(sessionsDeleteSpy).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        deleteTranscript: true,
        emitLifecycleHooks: true,
        key: "agent:main:subagent:test",
      },
      timeoutMs: 10_000,
    });
  });

  it("uses origin.provider for channel-specific queue settings in active announce delivery", async () => {
    mockConfig = {
      messages: {
        queue: {
          byChannel: {
            discord: "steer",
          },
        },
      },
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
    loadSessionStoreMock.mockImplementation(() => ({
      "agent:main:main": {
        origin: { provider: "discord" },
        sessionId: "session-origin-provider-steer",
        updatedAt: Date.now(),
      },
    }));
    isEmbeddedPiRunActiveMock.mockReturnValue(true);
    queueEmbeddedPiMessageMock.mockReturnValue(true);

    const didAnnounce = await runSubagentAnnounceFlow({
      childRunId: "run-origin-provider-steer",
      childSessionKey: "agent:main:subagent:test",
      cleanup: "keep",
      endedAt: 20,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      startedAt: 10,
      task: "do thing",
      timeoutMs: 10,
      waitForCompletion: false,
    });

    expect(didAnnounce).toBe(true);
    expect(queueEmbeddedPiMessageMock).toHaveBeenCalledWith(
      "session-origin-provider-steer",
      expect.stringContaining("[Internal task completion event]"),
    );
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("keeps completion direct announce session-only when requester origin is webchat", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      bestEffortDeliver: true,
      childRunId: "run-webchat-direct-announce",
      childSessionKey: "agent:main:subagent:webchat",
      cleanup: "keep",
      endedAt: 20,
      expectsCompletionMessage: true,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterOrigin: {
        accountId: "default",
        channel: "webchat",
        to: "chat:123",
      },
      requesterSessionKey: "agent:main:main",
      roundOneReply: "done",
      startedAt: 10,
      task: "deliver completion",
      timeoutMs: 10,
      waitForCompletion: false,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          accountId: "default",
          bestEffortDeliver: true,
          deliver: false,
          sessionKey: "agent:main:main",
        }),
      }),
    );
  });

  it("keeps nested subagent completion announces channel-less in session-only mode", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      bestEffortDeliver: true,
      childRunId: "run-nested-subagent-direct-announce",
      childSessionKey: "agent:main:subagent:worker",
      cleanup: "keep",
      endedAt: 20,
      expectsCompletionMessage: true,
      outcome: { status: "ok" },
      requesterDisplayKey: "orchestrator",
      requesterOrigin: {
        accountId: "default",
        channel: "telegram",
        to: "-100123",
      },
      requesterSessionKey: "agent:main:subagent:orchestrator",
      roundOneReply: "done",
      startedAt: 10,
      task: "deliver nested completion",
      timeoutMs: 10,
      waitForCompletion: false,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const call = agentSpy.mock.calls[0]?.[0];
    const params = call?.params ?? {};
    expect(params.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(params.deliver).toBe(false);
    expect(params.bestEffortDeliver).toBe(true);
    expect(params.channel).toBeUndefined();
    expect(params.to).toBeUndefined();
    expect(params.accountId).toBeUndefined();
    expect(params.threadId).toBeUndefined();
  });

  it("falls back to stored delivery target when mocked completion origins omit to", async () => {
    loadSessionStoreMock.mockImplementation(() => ({
      "agent:main:main": {
        lastAccountId: "bot:123",
        lastChannel: "telegram",
        lastTo: "-1001234567890",
        sessionId: "session-tg-group",
        updatedAt: Date.now(),
      },
    }));

    const didAnnounce = await runSubagentAnnounceFlow({
      childRunId: "run-tg-group-completion",
      childSessionKey: "agent:main:subagent:tg",
      cleanup: "keep",
      endedAt: 20,
      expectsCompletionMessage: true,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram" },
      requesterSessionKey: "agent:main:main",
      roundOneReply: "task done",
      startedAt: 10,
      task: "telegram group task",
      timeoutMs: 10,
      waitForCompletion: false,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const agentCall = agentSpy.mock.calls[0]?.[0];
    expect(agentCall?.params).toEqual(
      expect.objectContaining({
        accountId: "bot:123",
        channel: "telegram",
        deliver: true,
        to: "-1001234567890",
      }),
    );
  });
});
