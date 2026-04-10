import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

interface GatewayRequest { method?: string; params?: Record<string, unknown> }

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {
    agents: {
      defaults: {
        workspace: "/tmp",
      },
    },
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      sessions_spawn: {
        attachments: {
          enabled: true,
          maxFileBytes: 1 * 1024 * 1024,
          maxFiles: 50,
          maxTotalBytes: 5 * 1024 * 1024,
        },
      },
    },
  },
}));

const hookRunnerMocks = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
  runSubagentEnded: vi.fn(async () => {}),
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentSpawning: vi.fn(async (event: unknown) => {
    const input = event as {
      threadRequested?: boolean;
      requester?: { channel?: string };
    };
    if (!input.threadRequested) {
      return undefined;
    }
    const channel = input.requester?.channel?.trim().toLowerCase();
    if (channel !== "discord") {
      const channelLabel = input.requester?.channel?.trim() || "unknown";
      return {
        error: `thread=true is not supported for channel "${channelLabel}". Only Discord thread-bound subagent sessions are supported right now.`,
        status: "error" as const,
      };
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  }),
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function getGatewayRequests(): GatewayRequest[] {
  return hoisted.callGatewayMock.mock.calls.map((call) => call[0] as GatewayRequest);
}

function getGatewayMethods() {
  return getGatewayRequests().map((request) => request.method);
}

function findGatewayRequest(method: string): GatewayRequest | undefined {
  return getGatewayRequests().find((request) => request.method === method);
}

function setConfig(next: Record<string, unknown>) {
  hoisted.configOverride = createSubagentSpawnTestConfig(undefined, next);
}

async function spawn(params?: {
  toolCallId?: string;
  task?: string;
  label?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: "run" | "session";
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
}) {
  return await spawnSubagentDirect(
    {
      task: params?.task ?? "do thing",
      ...(params?.label ? { label: params.label } : {}),
      ...(typeof params?.runTimeoutSeconds === "number"
        ? { runTimeoutSeconds: params.runTimeoutSeconds }
        : {}),
      ...(params?.thread ? { thread: true } : {}),
      ...(params?.mode ? { mode: params.mode } : {}),
    },
    {
      agentAccountId: params?.agentAccountId,
      agentChannel: params?.agentChannel ?? "discord",
      agentSessionKey: params?.agentSessionKey ?? "main",
      agentThreadId: params?.agentThreadId,
      agentTo: params?.agentTo,
    },
  );
}

function expectSessionsDeleteWithoutAgentStart() {
  const methods = getGatewayMethods();
  expect(methods).toContain("sessions.delete");
  expect(methods).not.toContain("agent");
}

function mockAgentStartFailure() {
  hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent") {
      throw new Error("spawn failed");
    }
    return {};
  });
}

function getSpawnedEventCall(): Record<string, unknown> {
  const [event] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
    Record<string, unknown>,
  ];
  return event;
}

function expectErrorResultMessage(
  result: { error?: string; status: string },
  pattern: RegExp,
): void {
  expect(result.status).toBe("error");
  expect(result.error).toMatch(pattern);
}

function expectThreadBindFailureCleanup(
  result: { childSessionKey?: string; error?: string },
  pattern: RegExp,
): void {
  expect(result.error).toMatch(pattern);
  expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
  expectSessionsDeleteWithoutAgentStart();
  const deleteCall = findGatewayRequest("sessions.delete");
  expect(deleteCall?.params).toMatchObject({
    emitLifecycleHooks: false,
    key: result.childSessionKey,
  });
}

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: hoisted.callGatewayMock,
    hookRunner: {
      hasHooks: (hookName: string) =>
        hookName === "subagent_spawning" ||
        hookName === "subagent_spawned" ||
        (hookName === "subagent_ended" && hookRunnerMocks.hasSubagentEndedHook),
      runSubagentEnded: hookRunnerMocks.runSubagentEnded,
      runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
      runSubagentSpawning: hookRunnerMocks.runSubagentSpawning,
    },
    loadConfig: () => hoisted.configOverride,
    resetModules: false,
    sessionStorePath: "/tmp/subagent-spawn-hooks-session-store.json",
  }));
});

describe("sessions_spawn subagent lifecycle hooks", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hookRunnerMocks.hasSubagentEndedHook = true;
    hookRunnerMocks.runSubagentSpawning.mockClear();
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    setConfig({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    });
    hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { acceptedAt: 1001, runId: "run-1", status: "accepted" };
      }
      return {};
    });
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  it("runs subagent_spawning and emits subagent_spawned with requester metadata", async () => {
    const result = await spawn({
      agentAccountId: "work",
      agentThreadId: 456,
      agentTo: "channel:123",
      label: "research",
      runTimeoutSeconds: 1,
      thread: true,
    });

    expect(result).toMatchObject({ runId: "run-1", status: "accepted" });
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledWith(
      {
        agentId: "main",
        childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
        label: "research",
        mode: "session",
        requester: {
          accountId: "work",
          channel: "discord",
          threadId: 456,
          to: "channel:123",
        },
        threadRequested: true,
      },
      {
        childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
        requesterSessionKey: "main",
      },
    );

    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const [event, ctx] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      agentId: "main",
      label: "research",
      mode: "session",
      requester: {
        accountId: "work",
        channel: "discord",
        threadId: 456,
        to: "channel:123",
      },
      runId: "run-1",
      threadRequested: true,
    });
    expect(event.childSessionKey).toEqual(expect.stringMatching(/^agent:main:subagent:/));
    expect(ctx).toMatchObject({
      childSessionKey: event.childSessionKey,
      requesterSessionKey: "main",
      runId: "run-1",
    });
  });

  it("emits subagent_spawned with threadRequested=false when not requested", async () => {
    const result = await spawn({
      agentTo: "channel:123",
      runTimeoutSeconds: 1,
    });

    expect(result).toMatchObject({ runId: "run-1", status: "accepted" });
    expect(hookRunnerMocks.runSubagentSpawning).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const [event] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      mode: "run",
      requester: {
        channel: "discord",
        to: "channel:123",
      },
      threadRequested: false,
    });
  });

  it("respects explicit mode=run when thread binding is requested", async () => {
    const result = await spawn({
      agentTo: "channel:123",
      mode: "run",
      runTimeoutSeconds: 1,
      thread: true,
    });

    expect(result).toMatchObject({ mode: "run", runId: "run-1", status: "accepted" });
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    const event = getSpawnedEventCall();
    expect(event).toMatchObject({
      mode: "run",
      threadRequested: true,
    });
  });

  it("returns error when thread binding cannot be created", async () => {
    hookRunnerMocks.runSubagentSpawning.mockResolvedValueOnce({
      error: "Unable to create or bind a Discord thread for this subagent session.",
      status: "error",
    });
    const result = await spawn({
      agentAccountId: "work",
      agentTo: "channel:123",
      mode: "session",
      runTimeoutSeconds: 1,
      thread: true,
      toolCallId: "call4",
    });

    expectThreadBindFailureCleanup(result, /thread/i);
  });

  it("returns error when thread binding is not marked ready", async () => {
    hookRunnerMocks.runSubagentSpawning.mockResolvedValueOnce({
      status: "ok",
      threadBindingReady: false,
    });
    const result = await spawn({
      agentAccountId: "work",
      agentTo: "channel:123",
      mode: "session",
      runTimeoutSeconds: 1,
      thread: true,
      toolCallId: "call4b",
    });

    expectThreadBindFailureCleanup(result, /unable to create or bind a thread/i);
  });

  it("rejects mode=session when thread=true is not requested", async () => {
    const result = await spawn({
      agentTo: "channel:123",
      mode: "session",
    });

    expectErrorResultMessage(result, /requires thread=true/i);
    expect(hookRunnerMocks.runSubagentSpawning).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects thread=true on channels without thread support", async () => {
    const result = await spawn({
      agentChannel: "signal",
      agentTo: "+123",
      mode: "session",
      thread: true,
    });

    expectErrorResultMessage(result, /only discord/i);
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expectSessionsDeleteWithoutAgentStart();
  });

  it("runs subagent_ended cleanup hook when agent start fails after successful bind", async () => {
    mockAgentStartFailure();
    const result = await spawn({
      agentAccountId: "work",
      agentThreadId: "456",
      agentTo: "channel:123",
      mode: "session",
      thread: true,
    });

    expect(result).toMatchObject({ status: "error" });
    expect(hookRunnerMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const [event] = (hookRunnerMocks.runSubagentEnded.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      accountId: "work",
      error: "Session failed to start",
      outcome: "error",
      reason: "spawn-failed",
      sendFarewell: true,
      targetKind: "subagent",
      targetSessionKey: expect.stringMatching(/^agent:main:subagent:/),
    });
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      deleteTranscript: true,
      emitLifecycleHooks: false,
      key: event.targetSessionKey,
    });
  });

  it("falls back to sessions.delete cleanup when subagent_ended hook is unavailable", async () => {
    hookRunnerMocks.hasSubagentEndedHook = false;
    mockAgentStartFailure();
    const result = await spawn({
      agentAccountId: "work",
      agentThreadId: "456",
      agentTo: "channel:123",
      mode: "session",
      thread: true,
    });

    expect(result).toMatchObject({ status: "error" });
    expect(hookRunnerMocks.runSubagentEnded).not.toHaveBeenCalled();
    const methods = getGatewayMethods();
    expect(methods).toContain("sessions.delete");
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      deleteTranscript: true,
      emitLifecycleHooks: true,
    });
  });

  it("cleans up the provisional session when lineage patching fails after thread binding", async () => {
    hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.patch" && typeof request.params?.spawnedBy === "string") {
        throw new Error("lineage patch failed");
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { acceptedAt: 1001, runId: "run-1", status: "accepted" };
      }
      return {};
    });

    const result = await spawn({
      agentAccountId: "work",
      agentThreadId: "456",
      agentTo: "channel:123",
      mode: "session",
      thread: true,
    });

    expect(result).toMatchObject({
      error: "lineage patch failed",
      status: "error",
    });
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runSubagentEnded).not.toHaveBeenCalled();
    const methods = getGatewayMethods();
    expect(methods).toContain("sessions.delete");
    expect(methods).not.toContain("agent");
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      deleteTranscript: true,
      emitLifecycleHooks: true,
      key: result.childSessionKey,
    });
  });
});
