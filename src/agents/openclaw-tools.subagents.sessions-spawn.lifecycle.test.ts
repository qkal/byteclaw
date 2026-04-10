import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnAnnounceFlowOverride,
  resetSessionsSpawnConfigOverride,
  resetSessionsSpawnHookRunnerOverride,
  setSessionsSpawnConfigOverride,
  setSessionsSpawnHookRunnerOverride,
  setupSessionsSpawnGatewayMock,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import {
  getLatestSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

const fastModeEnv = vi.hoisted(() => {
  const previous = process.env.OPENCLAW_TEST_FAST;
  process.env.OPENCLAW_TEST_FAST = "1";
  return { previous };
});

const hookRunnerMocks = vi.hoisted(() => ({
  runSubagentEnded: vi.fn(async () => {}),
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentSpawning: vi.fn(async (event: unknown) => {
    const input = event as {
      threadRequested?: boolean;
    };
    if (!input.threadRequested) {
      return undefined;
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  }),
}));

vi.mock("./pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("./pi-embedded.js")>("./pi-embedded.js");
  return {
    ...actual,
    isEmbeddedPiRunActive: () => false,
    isEmbeddedPiRunStreaming: () => false,
    queueEmbeddedPiMessage: () => false,
    waitForEmbeddedPiRunEnd: async () => true,
  };
});

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: async () => "done",
}));

const callGatewayMock = getCallGatewayMock();
const RUN_TIMEOUT_SECONDS = 1;

function buildDiscordCleanupHooks(onDelete: (key: string | undefined) => void) {
  return {
    onAgentSubagentSpawn: (params: unknown) => {
      const rec = params as { channel?: string; timeout?: number } | undefined;
      expect(rec?.channel).toBe("discord");
      expect(rec?.timeout).toBe(1);
    },
    onSessionsDelete: (params: unknown) => {
      const rec = params as { key?: string } | undefined;
      onDelete(rec?.key);
    },
  };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1500) => {
  await vi.waitFor(
    () => {
      expect(predicate()).toBe(true);
    },
    { interval: 8, timeout: timeoutMs },
  );
};

async function getDiscordGroupSpawnTool() {
  return await getSessionsSpawnTool({
    agentChannel: "discord",
    agentSessionKey: "discord:group:req",
  });
}

async function executeSpawnAndExpectAccepted(params: {
  tool: Awaited<ReturnType<typeof getSessionsSpawnTool>>;
  callId: string;
  cleanup?: "delete" | "keep";
  label?: string;
  expectsCompletionMessage?: boolean;
}) {
  const result = await params.tool.execute(params.callId, {
    runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
    task: "do thing",
    ...(params.cleanup ? { cleanup: params.cleanup } : {}),
    ...(params.label ? { label: params.label } : {}),
    ...(params.expectsCompletionMessage === false ? { expectsCompletionMessage: false } : {}),
  });
  expect(result.details).toMatchObject({
    runId: "run-1",
    status: "accepted",
  });
  return result;
}

async function emitLifecycleEndAndFlush(params: {
  runId: string;
  startedAt: number;
  endedAt: number;
}) {
  vi.useFakeTimers();
  try {
    emitAgentEvent({
      data: {
        endedAt: params.endedAt,
        phase: "end",
        startedAt: params.startedAt,
      },
      runId: params.runId,
      stream: "lifecycle",
    });

    await vi.runAllTimersAsync();
  } finally {
    vi.useRealTimers();
  }
}

describe("openclaw-tools: subagents (sessions_spawn lifecycle)", () => {
  beforeEach(() => {
    resetSessionsSpawnAnnounceFlowOverride();
    resetSessionsSpawnHookRunnerOverride();
    resetSessionsSpawnConfigOverride();
    setSessionsSpawnConfigOverride({
      messages: {
        queue: {
          debounceMs: 0,
        },
      },
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    });
    resetSubagentRegistryForTests();
    hookRunnerMocks.runSubagentSpawning.mockClear();
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    setSessionsSpawnHookRunnerOverride({
      hasHooks: (hookName: string) =>
        hookName === "subagent_spawning" ||
        hookName === "subagent_spawned" ||
        hookName === "subagent_ended",
      runSubagentEnded: hookRunnerMocks.runSubagentEnded,
      runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
      runSubagentSpawning: hookRunnerMocks.runSubagentSpawning,
    });
    callGatewayMock.mockClear();
  });

  afterEach(() => {
    resetSessionsSpawnAnnounceFlowOverride();
    resetSessionsSpawnHookRunnerOverride();
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
  });

  afterAll(() => {
    if (fastModeEnv.previous === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = fastModeEnv.previous;
  });

  it("sessions_spawn runs cleanup flow after subagent completion", async () => {
    const patchCalls: { key?: string; label?: string }[] = [];

    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      includeSessionsList: true,
      onSessionsPatch: (params) => {
        const rec = params as { key?: string; label?: string } | undefined;
        patchCalls.push({ key: rec?.key, label: rec?.label });
      },
    });

    const tool = await getSessionsSpawnTool({
      agentChannel: "whatsapp",
      agentSessionKey: "main",
    });

    await executeSpawnAndExpectAccepted({
      callId: "call2",
      label: "my-task",
      tool,
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await waitFor(
      () =>
        ctx.waitCalls.some((call) => call.runId === child.runId) &&
        patchCalls.some((call) => call.label === "my-task") &&
        ctx.calls.filter((call) => call.method === "agent").length >= 2,
    );

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    // Cleanup should patch the label
    const labelPatch = patchCalls.find((call) => call.label === "my-task");
    expect(labelPatch?.key).toBe(child.sessionKey);
    expect(labelPatch?.label).toBe("my-task");

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = ctx.calls.filter((c) => c.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger (not "Sub-agent announce step." anymore)
    const second = agentCalls[1]?.params as { sessionKey?: string; message?: string } | undefined;
    expect(second?.sessionKey).toBe("agent:main:main");
    expect(second?.message).toContain("subagent task");

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn runs cleanup via lifecycle events", async () => {
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      ...buildDiscordCleanupHooks((key) => {
        deletedKey = key;
      }),
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      callId: "call1",
      cleanup: "delete",
      tool,
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await emitLifecycleEndAndFlush({
      endedAt: 2345,
      runId: child.runId,
      startedAt: 1234,
    });

    await waitFor(
      () => ctx.calls.filter((call) => call.method === "agent").length >= 2 && Boolean(deletedKey),
    );

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

    const first = agentCalls[0]?.params as
      | {
          lane?: string;
          deliver?: boolean;
          sessionKey?: string;
          channel?: string;
        }
      | undefined;
    expect(first?.lane).toBe("subagent");
    expect(first?.deliver).toBe(false);
    expect(first?.channel).toBe("discord");
    expect(first?.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    const second = agentCalls[1]?.params as
      | {
          sessionKey?: string;
          message?: string;
          deliver?: boolean;
        }
      | undefined;
    expect(second?.sessionKey).toBe("agent:main:discord:group:req");
    expect(second?.deliver).toBe(false);
    expect(second?.message).toContain("subagent task");

    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn deletes session when cleanup=delete via agent.wait", async () => {
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      ...buildDiscordCleanupHooks((key) => {
        deletedKey = key;
      }),
      agentWaitResult: { endedAt: 4000, startedAt: 3000, status: "ok" },
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      callId: "call1b",
      cleanup: "delete",
      tool,
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await waitFor(
      () =>
        ctx.waitCalls.some((call) => call.runId === child.runId) &&
        ctx.calls.filter((call) => call.method === "agent").length >= 2 &&
        Boolean(deletedKey),
    );

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger
    const second = agentCalls[1]?.params as { sessionKey?: string; deliver?: boolean } | undefined;
    expect(second?.sessionKey).toBe("agent:main:discord:group:req");
    expect(second?.deliver).toBe(false);

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    // Session should be deleted
    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn records timeout when agent.wait returns timeout", async () => {
    const ctx = setupSessionsSpawnGatewayMock({
      agentWaitResult: { endedAt: 7000, startedAt: 6000, status: "timeout" },
      chatHistoryText: "still working",
      includeChatHistory: true,
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      callId: "call-timeout",
      cleanup: "keep",
      expectsCompletionMessage: false,
      tool,
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    const childSessionKey = child.sessionKey;

    await waitFor(() => (
        ctx.waitCalls.some((call) => call.runId === child.runId) &&
        getLatestSubagentRunByChildSessionKey(childSessionKey)?.outcome?.status === "timeout"
      ), 20_000);

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(getLatestSubagentRunByChildSessionKey(childSessionKey)?.outcome?.status).toBe("timeout");
  });

  it("sessions_spawn announces with requester accountId", async () => {
    const ctx = setupSessionsSpawnGatewayMock({});

    const tool = await getSessionsSpawnTool({
      agentAccountId: "kev",
      agentChannel: "whatsapp",
      agentSessionKey: "main",
    });

    await executeSpawnAndExpectAccepted({
      callId: "call-announce-account",
      cleanup: "keep",
      tool,
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await emitLifecycleEndAndFlush({
      endedAt: 2000,
      runId: child.runId,
      startedAt: 1000,
    });

    await waitFor(() => ctx.calls.filter((call) => call.method === "agent").length >= 2);

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);
    const announceParams = agentCalls[1]?.params as
      | { accountId?: string; channel?: string; deliver?: boolean }
      | undefined;
    expect(announceParams?.deliver).toBe(false);
    expect(announceParams?.channel).toBeUndefined();
    expect(announceParams?.accountId).toBeUndefined();
  });
});
