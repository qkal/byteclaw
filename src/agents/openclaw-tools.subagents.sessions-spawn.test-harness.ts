import { type Mock, vi } from "vitest";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import { __testing as subagentRegistryTesting } from "./subagent-registry.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";
import { __testing as subagentSpawnTesting } from "./subagent-spawn.js";

type SessionsSpawnTestConfig = ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;
type SessionsSpawnHookRunner = SubagentLifecycleHookRunner | null;
type CaptureSubagentCompletionReply =
  (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow = (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];
type CreateSessionsSpawnTool =
  (typeof import("./tools/sessions-spawn-tool.js"))["createSessionsSpawnTool"];
export type CreateOpenClawToolsOpts = Parameters<CreateSessionsSpawnTool>[0];
export interface GatewayRequest {
  method?: string;
  params?: unknown;
}
export interface AgentWaitCall {
  runId?: string;
  timeoutMs?: number;
}
interface SessionsSpawnGatewayMockOptions {
  includeSessionsList?: boolean;
  includeChatHistory?: boolean;
  chatHistoryText?: string;
  onAgentSubagentSpawn?: (params: unknown) => void;
  onSessionsPatch?: (params: unknown) => void;
  onSessionsDelete?: (params: unknown) => void;
  agentWaitResult?: { status: "ok" | "timeout"; startedAt: number; endedAt: number };
}

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const defaultConfigOverride = {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
  } as SessionsSpawnTestConfig;
  let configOverride = defaultConfigOverride;
  const defaultRunSubagentAnnounceFlow: RunSubagentAnnounceFlow = async (params) => {
    const statusLabel =
      params.outcome?.status === "timeout" ? "timed out" : "completed successfully";
    const requesterSessionKey = resolveRequesterStoreKey(
      configOverride,
      params.requesterSessionKey,
    );

    await callGatewayMock({
      method: "agent",
      params: {
        deliver: false,
        message: `subagent task ${statusLabel}`,
        sessionKey: requesterSessionKey,
      },
    });

    if (params.label) {
      await callGatewayMock({
        method: "sessions.patch",
        params: {
          key: params.childSessionKey,
          label: params.label,
        },
      });
    }

    if (params.cleanup === "delete") {
      await callGatewayMock({
        method: "sessions.delete",
        params: {
          deleteTranscript: true,
          emitLifecycleHooks: params.spawnMode === "session",
          key: params.childSessionKey,
        },
      });
    }

    return true;
  };
  const defaultCaptureSubagentCompletionReply: CaptureSubagentCompletionReply = async () =>
    undefined;
  const state = {
    captureSubagentCompletionReplyOverride: defaultCaptureSubagentCompletionReply,
    get configOverride() {
      return configOverride;
    },
    set configOverride(next: SessionsSpawnTestConfig) {
      configOverride = next;
    },
    defaultCaptureSubagentCompletionReply,
    defaultRunSubagentAnnounceFlow,
    hookRunnerOverride: null as SessionsSpawnHookRunner,
    runSubagentAnnounceFlowOverride: defaultRunSubagentAnnounceFlow,
  };
  return { callGatewayMock, defaultConfigOverride, state };
});

let cachedCreateSessionsSpawnTool: CreateSessionsSpawnTool | null = null;

export function getCallGatewayMock(): Mock {
  return hoisted.callGatewayMock;
}

export function getGatewayRequests(): GatewayRequest[] {
  return getCallGatewayMock().mock.calls.map((call: unknown[]) => call[0] as GatewayRequest);
}

export function getGatewayMethods(): (string | undefined)[] {
  return getGatewayRequests().map((request) => request.method);
}

export function findGatewayRequest(method: string): GatewayRequest | undefined {
  return getGatewayRequests().find((request) => request.method === method);
}

export function resetSessionsSpawnConfigOverride(): void {
  hoisted.state.configOverride = hoisted.defaultConfigOverride;
}

export function setSessionsSpawnConfigOverride(next: SessionsSpawnTestConfig): void {
  hoisted.state.configOverride = next;
}

export function resetSessionsSpawnAnnounceFlowOverride(): void {
  hoisted.state.runSubagentAnnounceFlowOverride = hoisted.state.defaultRunSubagentAnnounceFlow;
}

export function resetSessionsSpawnHookRunnerOverride(): void {
  hoisted.state.hookRunnerOverride = null;
}

export function setSessionsSpawnHookRunnerOverride(next: SessionsSpawnHookRunner): void {
  hoisted.state.hookRunnerOverride = next;
}

export function setSessionsSpawnAnnounceFlowOverride(next: RunSubagentAnnounceFlow): void {
  hoisted.state.runSubagentAnnounceFlowOverride = next;
}

export async function getSessionsSpawnTool(opts: CreateOpenClawToolsOpts) {
  subagentSpawnTesting.setDepsForTest({
    callGateway: (optsUnknown) => hoisted.callGatewayMock(optsUnknown),
    getGlobalHookRunner: () => hoisted.state.hookRunnerOverride,
    loadConfig: () => hoisted.state.configOverride,
    updateSessionStore: async (_storePath, mutator) => mutator({}),
  });
  subagentRegistryTesting.setDepsForTest({
    callGateway: (optsUnknown) => hoisted.callGatewayMock(optsUnknown),
    captureSubagentCompletionReply: (sessionKey) =>
      hoisted.state.captureSubagentCompletionReplyOverride(sessionKey),
    loadConfig: () => hoisted.state.configOverride,
    runSubagentAnnounceFlow: (params) => hoisted.state.runSubagentAnnounceFlowOverride(params),
  });
  if (!cachedCreateSessionsSpawnTool) {
    ({ createSessionsSpawnTool: cachedCreateSessionsSpawnTool } =
      await import("./tools/sessions-spawn-tool.js"));
  }
  return cachedCreateSessionsSpawnTool(opts);
}

export function setupSessionsSpawnGatewayMock(setupOpts: SessionsSpawnGatewayMockOptions): {
  calls: GatewayRequest[];
  waitCalls: AgentWaitCall[];
  getChild: () => { runId?: string; sessionKey?: string };
} {
  const calls: GatewayRequest[] = [];
  const waitCalls: AgentWaitCall[] = [];
  let agentCallCount = 0;
  let childRunId: string | undefined;
  let childSessionKey: string | undefined;

  getCallGatewayMock().mockImplementation(async (optsUnknown: unknown) => {
    const request = optsUnknown as GatewayRequest;
    calls.push(request);

    if (request.method === "sessions.list" && setupOpts.includeSessionsList) {
      return {
        sessions: [
          {
            key: "main",
            lastChannel: "whatsapp",
            lastTo: "+123",
          },
        ],
      };
    }

    if (request.method === "agent") {
      agentCallCount += 1;
      const runId = `run-${agentCallCount}`;
      const params = request.params as { lane?: string; sessionKey?: string } | undefined;
      // Capture only the subagent run metadata.
      if (params?.lane === "subagent") {
        childRunId = runId;
        childSessionKey = params.sessionKey ?? "";
        setupOpts.onAgentSubagentSpawn?.(params);
      }
      return {
        acceptedAt: 1000 + agentCallCount,
        runId,
        status: "accepted",
      };
    }

    if (request.method === "agent.wait") {
      const params = request.params as AgentWaitCall | undefined;
      waitCalls.push(params ?? {});
      const waitResult = setupOpts.agentWaitResult ?? {
        endedAt: 2000,
        startedAt: 1000,
        status: "ok",
      };
      return {
        runId: params?.runId ?? "run-1",
        ...waitResult,
      };
    }

    if (request.method === "sessions.patch") {
      setupOpts.onSessionsPatch?.(request.params);
      return { ok: true };
    }

    if (request.method === "sessions.delete") {
      setupOpts.onSessionsDelete?.(request.params);
      return { ok: true };
    }

    if (request.method === "chat.history" && setupOpts.includeChatHistory) {
      return {
        messages: [
          {
            content: [{ text: setupOpts.chatHistoryText ?? "done", type: "text" }],
            role: "assistant",
          },
        ],
      };
    }

    return {};
  });

  return {
    calls,
    getChild: () => ({ runId: childRunId, sessionKey: childSessionKey }),
    waitCalls,
  };
}

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));
// Some tools import callGateway via "../../gateway/call.js" (from nested folders). Mock that too.
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => hoisted.state.configOverride,
    resolveGatewayPort: () => 18_789,
  };
});

// Same module, different specifier (used by tools under src/agents/tools/*).
vi.mock("../../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => hoisted.state.configOverride,
    resolveGatewayPort: () => 18_789,
  };
});
