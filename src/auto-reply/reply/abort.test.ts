import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  __testing as abortTesting,
  getAbortMemory,
  getAbortMemorySizeForTest,
  isAbortRequestText,
  isAbortTrigger,
  resetAbortMemoryForTest,
  resolveAbortCutoffFromContext,
  resolveSessionEntryForKey,
  setAbortMemory,
  shouldSkipMessageByAbortCutoff,
  stopSubagentsForRequester,
  tryFastAbortFromMessage,
} from "./abort.js";
import { type FollowupRun, enqueueFollowupRun, getFollowupQueueDepth } from "./queue.js";
import { __testing as queueCleanupTesting } from "./queue/cleanup.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(true),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

const commandQueueMocks = vi.hoisted(() => ({
  clearCommandLane: vi.fn(() => 1),
}));

vi.mock("../../process/command-queue.js", () => commandQueueMocks);

const subagentRegistryMocks = vi.hoisted(() => ({
  getLatestSubagentRunByChildSessionKey: vi.fn<
    (childSessionKey: string) => SubagentRunRecord | null
  >(() => null),
  listSubagentRunsForRequester: vi.fn<(requesterSessionKey: string) => SubagentRunRecord[]>(
    () => [],
  ),
  markSubagentRunTerminated: vi.fn(() => 1),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey:
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
  listSubagentRunsForRequester: subagentRegistryMocks.listSubagentRunsForRequester,
  markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
}));

const acpManagerMocks = vi.hoisted(() => ({
  cancelSession: vi.fn(async () => {}),
  resolveSession: vi.fn<
    () =>
      | { kind: "none" }
      | {
          kind: "ready";
          sessionKey: string;
          meta: unknown;
        }
  >(() => ({ kind: "none" })),
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: acpManagerMocks.cancelSession,
    resolveSession: acpManagerMocks.resolveSession,
  }),
}));

describe("abort detection", () => {
  async function writeSessionStore(
    storePath: string,
    sessionIdsByKey: Record<string, string>,
    nowMs = Date.now(),
  ) {
    const storeEntries = Object.fromEntries(
      Object.entries(sessionIdsByKey).map(([key, sessionId]) => [
        key,
        { sessionId, updatedAt: nowMs },
      ]),
    );
    await fs.writeFile(storePath, JSON.stringify(storeEntries, null, 2));
  }

  async function createAbortConfig(params?: {
    commandsTextEnabled?: boolean;
    sessionIdsByKey?: Record<string, string>;
    nowMs?: number;
  }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: { store: storePath },
      ...(typeof params?.commandsTextEnabled === "boolean"
        ? { commands: { text: params.commandsTextEnabled } }
        : {}),
    } as OpenClawConfig;
    if (params?.sessionIdsByKey) {
      await writeSessionStore(storePath, params.sessionIdsByKey, params.nowMs);
    }
    return { cfg, root, storePath };
  }

  async function runStopCommand(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    from: string;
    to: string;
    targetSessionKey?: string;
    messageSid?: string;
    timestamp?: number;
  }) {
    return tryFastAbortFromMessage({
      cfg: params.cfg,
      ctx: buildTestCtx({
        CommandAuthorized: true,
        CommandBody: "/stop",
        From: params.from,
        Provider: "telegram",
        RawBody: "/stop",
        SessionKey: params.sessionKey,
        Surface: "telegram",
        To: params.to,
        ...(params.targetSessionKey ? { CommandTargetSessionKey: params.targetSessionKey } : {}),
        ...(params.messageSid ? { MessageSid: params.messageSid } : {}),
        ...(typeof params.timestamp === "number" ? { Timestamp: params.timestamp } : {}),
      }),
    });
  }

  function enqueueQueuedFollowupRun(params: {
    root: string;
    cfg: OpenClawConfig;
    sessionId: string;
    sessionKey: string;
  }) {
    const followupRun: FollowupRun = {
      enqueuedAt: Date.now(),
      prompt: "queued",
      run: {
        agentAccountId: "acct",
        agentDir: path.join(params.root, "agent"),
        agentId: "main",
        blockReplyBreak: "text_end",
        config: params.cfg,
        messageProvider: "telegram",
        model: "claude-opus-4-6",
        provider: "anthropic",
        sessionFile: path.join(params.root, "session.jsonl"),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        timeoutMs: 1000,
        workspaceDir: path.join(params.root, "workspace"),
      },
    };
    enqueueFollowupRun(
      params.sessionKey,
      followupRun,
      { cap: 20, debounceMs: 0, dropPolicy: "summarize", mode: "collect" },
      "none",
    );
  }

  function expectSessionLaneCleared(sessionKey: string) {
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${sessionKey}`);
  }

  beforeEach(() => {
    abortTesting.setDepsForTests({
      abortEmbeddedPiRun: () => true,
      getAcpSessionManager: (() =>
        ({
          cancelSession: acpManagerMocks.cancelSession,
          resolveSession: acpManagerMocks.resolveSession,
        }) as never) as never,
      getLatestSubagentRunByChildSessionKey:
        subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
      listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
      markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
    });
    queueCleanupTesting.setDepsForTests({
      clearCommandLane: commandQueueMocks.clearCommandLane,
      resolveEmbeddedSessionLane: (key) => `session:${key.trim() || "main"}`,
    });
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
  });

  afterEach(() => {
    resetAbortMemoryForTest();
    abortTesting.resetDepsForTests();
    queueCleanupTesting.resetDepsForTests();
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
    acpManagerMocks.resolveSession.mockReset().mockReturnValue({ kind: "none" });
    acpManagerMocks.cancelSession.mockReset().mockResolvedValue(undefined);
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(null);
  });

  it("isAbortTrigger matches standalone abort trigger phrases", () => {
    const positives = [
      "stop",
      "esc",
      "abort",
      "wait",
      "exit",
      "interrupt",
      "stop openclaw",
      "openclaw stop",
      "stop action",
      "stop current action",
      "stop run",
      "stop current run",
      "stop agent",
      "stop the agent",
      "stop don't do anything",
      "stop dont do anything",
      "stop do not do anything",
      "stop doing anything",
      "do not do that",
      "please stop",
      "stop please",
      "STOP OPENCLAW",
      "stop openclaw!!!",
      "stop don’t do anything",
      "detente",
      "detén",
      "arrête",
      "停止",
      "やめて",
      "止めて",
      "रुको",
      "توقف",
      "стоп",
      "остановись",
      "останови",
      "остановить",
      "прекрати",
      "halt",
      "anhalten",
      "aufhören",
      "hoer auf",
      "stopp",
      "pare",
    ];
    for (const candidate of positives) {
      expect(isAbortTrigger(candidate)).toBe(true);
    }

    expect(isAbortTrigger("hello")).toBe(false);
    expect(isAbortTrigger("please do not do that")).toBe(false);
    // /stop is NOT matched by isAbortTrigger - it's handled separately.
    expect(isAbortTrigger("/stop")).toBe(false);
  });

  it("isAbortRequestText aligns abort command semantics", () => {
    expect(isAbortRequestText("/stop")).toBe(true);
    expect(isAbortRequestText("/STOP")).toBe(true);
    expect(isAbortRequestText("/stop!!!")).toBe(true);
    expect(isAbortRequestText("/Stop!!!")).toBe(true);
    expect(isAbortRequestText("stop")).toBe(true);
    expect(isAbortRequestText("Stop")).toBe(true);
    expect(isAbortRequestText("STOP")).toBe(true);
    expect(isAbortRequestText("stop action")).toBe(true);
    expect(isAbortRequestText("stop openclaw!!!")).toBe(true);
    expect(isAbortRequestText("やめて")).toBe(true);
    expect(isAbortRequestText("остановись")).toBe(true);
    expect(isAbortRequestText("halt")).toBe(true);
    expect(isAbortRequestText("stopp")).toBe(true);
    expect(isAbortRequestText("pare")).toBe(true);
    expect(isAbortRequestText(" توقف ")).toBe(true);
    expect(isAbortRequestText("/stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);
    expect(isAbortRequestText("/Stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);

    expect(isAbortRequestText("/status")).toBe(false);
    expect(isAbortRequestText("do not do that")).toBe(true);
    expect(isAbortRequestText("please do not do that")).toBe(false);
    expect(isAbortRequestText("/abort")).toBe(false);
  });

  it("removes abort memory entry when flag is reset", () => {
    setAbortMemory("session-1", true);
    expect(getAbortMemory("session-1")).toBe(true);

    setAbortMemory("session-1", false);
    expect(getAbortMemory("session-1")).toBeUndefined();
    expect(getAbortMemorySizeForTest()).toBe(0);
  });

  it("caps abort memory tracking to a bounded max size", () => {
    for (let i = 0; i < 2105; i += 1) {
      setAbortMemory(`session-${i}`, true);
    }
    expect(getAbortMemorySizeForTest()).toBe(2000);
    expect(getAbortMemory("session-0")).toBeUndefined();
    expect(getAbortMemory("session-2104")).toBe(true);
  });

  it("extracts abort cutoff metadata from context", () => {
    expect(
      resolveAbortCutoffFromContext(
        buildTestCtx({
          MessageSid: "42",
          Timestamp: 123,
        }),
      ),
    ).toEqual({
      messageSid: "42",
      timestamp: 123,
    });
  });

  it("treats numeric message IDs at or before cutoff as stale", () => {
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "199",
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "200",
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "201",
      }),
    ).toBe(false);
  });

  it("falls back to timestamp cutoff when message IDs are unavailable", () => {
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 1999,
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 2000,
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 2001,
      }),
    ).toBe(false);
  });

  it("resolves session entry when key exists in store", () => {
    const store = {
      "session-1": { sessionId: "abc", updatedAt: 0 },
    } as const;
    expect(resolveSessionEntryForKey(store, "session-1")).toEqual({
      entry: store["session-1"],
      key: "session-1",
    });
    expect(resolveSessionEntryForKey(store, "session-2")).toEqual({});
    expect(resolveSessionEntryForKey(undefined, "session-1")).toEqual({});
  });

  it("resolves Telegram forum topic session when lookup key has different casing than store", () => {
    // Store normalizes keys to lowercase; caller may pass mixed-case. /stop in topic must find entry.
    const storeKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const lookupKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
    const store = {
      [storeKey]: { sessionId: "pi-topic-99", updatedAt: 0 },
    } as Record<string, { sessionId: string; updatedAt: number }>;
    // Direct lookup fails (store uses lowercase keys); normalization fallback must succeed.
    expect(store[lookupKey]).toBeUndefined();
    const result = resolveSessionEntryForKey(store, lookupKey);
    expect(result.entry?.sessionId).toBe("pi-topic-99");
    expect(result.key).toBe(storeKey);
  });

  it("fast-aborts even when text commands are disabled", async () => {
    const { cfg } = await createAbortConfig({ commandsTextEnabled: false });

    const result = await runStopCommand({
      cfg,
      from: "telegram:123",
      sessionKey: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
  });

  it("fast-abort clears queued followups and session lane", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    enqueueQueuedFollowupRun({ cfg, root, sessionId, sessionKey });
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);

    const result = await runStopCommand({
      cfg,
      from: "telegram:123",
      sessionKey,
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
  });

  it("plain-language stop on ACP-bound session triggers ACP cancel", async () => {
    const sessionKey = "agent:codex:acp:test-1";
    const sessionId = "session-123";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      meta: {} as never,
      sessionKey,
    });

    const result = await runStopCommand({
      cfg,
      from: "telegram:123",
      sessionKey,
      targetSessionKey: sessionKey,
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg,
      reason: "fast-abort",
      sessionKey,
    });
  });

  it("ACP cancel failures do not skip queue and lane cleanup", async () => {
    const sessionKey = "agent:codex:acp:test-2";
    const sessionId = "session-456";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    enqueueQueuedFollowupRun({ cfg, root, sessionId, sessionKey });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      meta: {} as never,
      sessionKey,
    });
    acpManagerMocks.cancelSession.mockRejectedValueOnce(new Error("cancel failed"));

    const result = await runStopCommand({
      cfg,
      from: "telegram:123",
      sessionKey,
      targetSessionKey: sessionKey,
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
  });

  it("persists abort cutoff metadata on /stop when command and target session match", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });

    const result = await runStopCommand({
      cfg,
      from: "telegram:123",
      messageSid: "55",
      sessionKey,
      timestamp: 1_234_567_890_000,
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;
    const entry = store[sessionKey] as {
      abortedLastRun?: boolean;
      abortCutoffMessageSid?: string;
      abortCutoffTimestamp?: number;
    };
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.abortCutoffMessageSid).toBe("55");
    expect(entry.abortCutoffTimestamp).toBe(1_234_567_890_000);
  });

  it("does not persist cutoff metadata when native /stop targets a different session", async () => {
    const slashSessionKey = "telegram:slash:123";
    const targetSessionKey = "agent:main:telegram:group:123";
    const targetSessionId = "session-target";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [targetSessionKey]: targetSessionId },
    });

    const result = await runStopCommand({
      cfg,
      from: "telegram:123",
      messageSid: "999",
      sessionKey: slashSessionKey,
      targetSessionKey,
      timestamp: 1_234_567_890_000,
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;
    const entry = store[targetSessionKey] as {
      abortedLastRun?: boolean;
      abortCutoffMessageSid?: string;
      abortCutoffTimestamp?: number;
    };
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.abortCutoffMessageSid).toBeUndefined();
    expect(entry.abortCutoffTimestamp).toBeUndefined();
  });

  it("fast-abort stops active subagent runs for requester session", async () => {
    const sessionKey = "telegram:parent";
    const childKey = "agent:main:subagent:child-1";
    const sessionId = "session-parent";
    const childSessionId = "session-child";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: sessionId,
        [childKey]: childSessionId,
      },
    });

    subagentRegistryMocks.listSubagentRunsForRequester.mockReturnValueOnce([
      {
        childSessionKey: childKey,
        cleanup: "keep",
        createdAt: Date.now(),
        requesterDisplayKey: "telegram:parent",
        requesterSessionKey: sessionKey,
        runId: "run-1",
        task: "do work",
      },
    ]);

    const result = await runStopCommand({
      cfg,
      from: "telegram:parent",
      sessionKey,
      to: "telegram:parent",
    });

    expect(result.stoppedSubagents).toBe(1);
    expectSessionLaneCleared(childKey);
  });

  it("cascade stop kills depth-2 children when stopping depth-1 agent", async () => {
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-1";
    const depth2Key = "agent:main:subagent:child-1:subagent:grandchild-1";
    const sessionId = "session-parent";
    const depth1SessionId = "session-child";
    const depth2SessionId = "session-grandchild";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: sessionId,
        [depth1Key]: depth1SessionId,
        [depth2Key]: depth2SessionId,
      },
    });

    // First call: main session lists depth-1 children
    // Second call (cascade): depth-1 session lists depth-2 children
    // Third call (cascade from depth-2): no further children
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          childSessionKey: depth1Key,
          cleanup: "keep",
          createdAt: Date.now(),
          requesterDisplayKey: "telegram:parent",
          requesterSessionKey: sessionKey,
          runId: "run-1",
          task: "orchestrator",
        },
      ])
      .mockReturnValueOnce([
        {
          childSessionKey: depth2Key,
          cleanup: "keep",
          createdAt: Date.now(),
          requesterDisplayKey: depth1Key,
          requesterSessionKey: depth1Key,
          runId: "run-2",
          task: "leaf worker",
        },
      ])
      .mockReturnValueOnce([]);

    const result = await runStopCommand({
      cfg,
      from: "telegram:parent",
      sessionKey,
      to: "telegram:parent",
    });

    // Should stop both depth-1 and depth-2 agents (cascade)
    expect(result.stoppedSubagents).toBe(2);
    expectSessionLaneCleared(depth1Key);
    expectSessionLaneCleared(depth2Key);
  });

  it("cascade stop traverses ended depth-1 parents to stop active depth-2 children", async () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-ended";
    const depth2Key = "agent:main:subagent:child-ended:subagent:grandchild-active";
    const now = Date.now();
    const { cfg } = await createAbortConfig({
      nowMs: now,
      sessionIdsByKey: {
        [sessionKey]: "session-parent",
        [depth1Key]: "session-child-ended",
        [depth2Key]: "session-grandchild-active",
      },
    });

    // Main -> ended depth-1 parent
    // Depth-1 parent -> active depth-2 child
    // Depth-2 child -> none
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          childSessionKey: depth1Key,
          cleanup: "keep",
          createdAt: now - 1000,
          endedAt: now - 500,
          outcome: { status: "ok" },
          requesterDisplayKey: "telegram:parent",
          requesterSessionKey: sessionKey,
          runId: "run-1",
          task: "orchestrator",
        },
      ])
      .mockReturnValueOnce([
        {
          childSessionKey: depth2Key,
          cleanup: "keep",
          createdAt: now - 500,
          requesterDisplayKey: depth1Key,
          requesterSessionKey: depth1Key,
          runId: "run-2",
          task: "leaf worker",
        },
      ])
      .mockReturnValueOnce([]);

    const result = await runStopCommand({
      cfg,
      from: "telegram:parent",
      sessionKey,
      to: "telegram:parent",
    });

    // Should skip killing the ended depth-1 run itself, but still kill depth-2.
    expect(result.stoppedSubagents).toBe(1);
    expectSessionLaneCleared(depth2Key);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionKey: depth2Key, runId: "run-2" }),
    );
  });

  it("cascade stop still traverses an ended current parent when a stale older active row exists", async () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-ended-stale";
    const depth2Key = "agent:main:subagent:child-ended-stale:subagent:grandchild-active";
    const now = Date.now();
    const { cfg } = await createAbortConfig({
      nowMs: now,
      sessionIdsByKey: {
        [sessionKey]: "session-parent",
        [depth1Key]: "session-child-ended-stale",
        [depth2Key]: "session-grandchild-active",
      },
    });

    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          childSessionKey: depth1Key,
          cleanup: "keep",
          createdAt: now - 2000,
          requesterDisplayKey: "telegram:parent",
          requesterSessionKey: sessionKey,
          runId: "run-stale-parent",
          startedAt: now - 1900,
          task: "stale orchestrator",
        },
        {
          childSessionKey: depth1Key,
          cleanup: "keep",
          createdAt: now - 1000,
          endedAt: now - 500,
          outcome: { status: "ok" },
          requesterDisplayKey: "telegram:parent",
          requesterSessionKey: sessionKey,
          runId: "run-current-parent",
          startedAt: now - 900,
          task: "current orchestrator",
        },
      ])
      .mockReturnValueOnce([
        {
          childSessionKey: depth2Key,
          cleanup: "keep",
          createdAt: now - 400,
          requesterDisplayKey: depth1Key,
          requesterSessionKey: depth1Key,
          runId: "run-active-child",
          task: "leaf worker",
        },
      ])
      .mockReturnValueOnce([]);
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey.mockImplementation(
      (childSessionKey) => {
        if (childSessionKey === depth1Key) {
          return {
            childSessionKey: depth1Key,
            cleanup: "keep",
            createdAt: now - 1000,
            endedAt: now - 500,
            outcome: { status: "ok" },
            requesterDisplayKey: "telegram:parent",
            requesterSessionKey: sessionKey,
            runId: "run-current-parent",
            startedAt: now - 900,
            task: "current orchestrator",
          } as SubagentRunRecord;
        }
        if (childSessionKey === depth2Key) {
          return {
            childSessionKey: depth2Key,
            cleanup: "keep",
            createdAt: now - 400,
            requesterDisplayKey: depth1Key,
            requesterSessionKey: depth1Key,
            runId: "run-active-child",
            task: "leaf worker",
          } as SubagentRunRecord;
        }
        return null;
      },
    );

    const result = await runStopCommand({
      cfg,
      from: "telegram:parent",
      sessionKey,
      to: "telegram:parent",
    });

    expect(result.stoppedSubagents).toBe(1);
    expectSessionLaneCleared(depth2Key);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionKey: depth2Key, runId: "run-active-child" }),
    );
  });

  it("stopSubagentsForRequester does not traverse a child that moved to a newer parent", async () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const oldParentKey = "agent:main:subagent:old-parent";
    const newParentKey = "agent:main:subagent:new-parent";
    const childKey = "agent:main:subagent:shared-child";
    const leafKey = `${childKey}:subagent:leaf`;
    const now = Date.now();

    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          childSessionKey: childKey,
          cleanup: "keep",
          controllerSessionKey: oldParentKey,
          createdAt: now - 2000,
          endedAt: now - 1000,
          outcome: { status: "ok" },
          requesterDisplayKey: oldParentKey,
          requesterSessionKey: oldParentKey,
          runId: "run-shared-child-stale-parent",
          task: "shared child stale parent",
        },
      ])
      .mockReturnValueOnce([
        {
          childSessionKey: leafKey,
          cleanup: "keep",
          controllerSessionKey: childKey,
          createdAt: now - 500,
          requesterDisplayKey: childKey,
          requesterSessionKey: childKey,
          runId: "run-leaf-active",
          task: "leaf worker",
        },
      ]);
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey.mockImplementation((sessionKey) => {
      if (sessionKey === childKey) {
        return {
          childSessionKey: childKey,
          cleanup: "keep",
          controllerSessionKey: newParentKey,
          createdAt: now - 250,
          requesterDisplayKey: newParentKey,
          requesterSessionKey: newParentKey,
          runId: "run-shared-child-current-parent",
          task: "shared child current parent",
        } as SubagentRunRecord;
      }
      if (sessionKey === leafKey) {
        return {
          childSessionKey: leafKey,
          cleanup: "keep",
          controllerSessionKey: childKey,
          createdAt: now - 500,
          requesterDisplayKey: childKey,
          requesterSessionKey: childKey,
          runId: "run-leaf-active",
          task: "leaf worker",
        } as SubagentRunRecord;
      }
      return null;
    });

    const result = stopSubagentsForRequester({
      cfg: {} as OpenClawConfig,
      requesterSessionKey: oldParentKey,
    });

    expect(result).toEqual({ stopped: 0 });
    expect(subagentRegistryMocks.markSubagentRunTerminated).not.toHaveBeenCalled();
  });
});
