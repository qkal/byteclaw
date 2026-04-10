import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

interface TestAgentConfig {
  id?: string;
  workspace?: string;
  subagents?: {
    allowAgents?: string[];
  };
}

interface TestConfig {
  agents?: {
    list?: TestAgentConfig[];
  };
}

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  hookRunner: {
    hasHooks: vi.fn(() => false),
    runSubagentSpawning: vi.fn(),
  },
  registerSubagentRunMock: vi.fn(),
}));

let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: () => "",
    getOAuthProviders: () => [],
  };
});

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig("/tmp/workspace-main", {
    agents: {
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  });
}

function resolveTestAgentConfig(cfg: Record<string, unknown>, agentId: string) {
  return (cfg as TestConfig).agents?.list?.find((entry) => entry.id === agentId);
}

function resolveTestAgentWorkspace(cfg: Record<string, unknown>, agentId: string) {
  return resolveTestAgentConfig(cfg, agentId)?.workspace ?? `/tmp/workspace-${agentId}`;
}

function getRegisteredRun() {
  return hoisted.registerSubagentRunMock.mock.calls.at(0)?.[0] as
    | Record<string, unknown>
    | undefined;
}

async function expectAcceptedWorkspace(params: { agentId: string; expectedWorkspaceDir: string }) {
  const result = await spawnSubagentDirect(
    {
      agentId: params.agentId,
      task: "inspect workspace",
    },
    {
      agentAccountId: "123",
      agentChannel: "telegram",
      agentSessionKey: "agent:main:main",
      agentTo: "456",
      workspaceDir: "/tmp/requester-workspace",
    },
  );

  expect(result.status).toBe("accepted");
  expect(getRegisteredRun()).toMatchObject({
    workspaceDir: params.expectedWorkspaceDir,
  });
}

describe("spawnSubagentDirect workspace inheritance", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      hookRunner: hoisted.hookRunner,
      loadConfig: () => hoisted.configOverride,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      resetModules: false,
      resolveAgentConfig: resolveTestAgentConfig,
      resolveAgentWorkspaceDir: resolveTestAgentWorkspace,
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockClear();
    hoisted.registerSubagentRunMock.mockClear();
    hoisted.hookRunner.hasHooks.mockReset();
    hoisted.hookRunner.hasHooks.mockImplementation(() => false);
    hoisted.hookRunner.runSubagentSpawning.mockReset();
    hoisted.configOverride = createConfigOverride();
    setupAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
  });

  it("uses the target agent workspace for cross-agent spawns", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["ops"],
            },
            workspace: "/tmp/workspace-main",
          },
          {
            id: "ops",
            workspace: "/tmp/workspace-ops",
          },
        ],
      },
    });

    await expectAcceptedWorkspace({
      agentId: "ops",
      expectedWorkspaceDir: "/tmp/workspace-ops",
    });
  });

  it("preserves the inherited workspace for same-agent spawns", async () => {
    await expectAcceptedWorkspace({
      agentId: "main",
      expectedWorkspaceDir: "/tmp/requester-workspace",
    });
  });

  it("passes lightweight bootstrap context flags for lightContext subagent spawns", async () => {
    await spawnSubagentDirect(
      {
        lightContext: true,
        task: "inspect workspace",
      },
      {
        agentAccountId: "123",
        agentChannel: "telegram",
        agentSessionKey: "agent:main:main",
        agentTo: "456",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;

    expect(agentCall?.params).toMatchObject({
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "default",
    });
  });

  it("omits bootstrap context flags for default subagent spawns", async () => {
    await spawnSubagentDirect(
      {
        task: "inspect workspace",
      },
      {
        agentAccountId: "123",
        agentChannel: "telegram",
        agentSessionKey: "agent:main:main",
        agentTo: "456",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;

    expect(agentCall?.params).not.toHaveProperty("bootstrapContextMode");
    expect(agentCall?.params).not.toHaveProperty("bootstrapContextRunKind");
  });

  it("deletes the provisional child session when a non-thread subagent start fails", async () => {
    hoisted.callGatewayMock.mockImplementation(
      async (request: {
        method?: string;
        params?: { key?: string; deleteTranscript?: boolean; emitLifecycleHooks?: boolean };
      }) => {
        if (request.method === "sessions.patch") {
          return { ok: true };
        }
        if (request.method === "agent") {
          throw new Error("spawn startup failed");
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "fail after provisional session creation",
      },
      {
        agentAccountId: "acct-1",
        agentChannel: "discord",
        agentSessionKey: "agent:main:main",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result).toMatchObject({
      error: "spawn startup failed",
      status: "error",
    });
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();

    const deleteCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "sessions.delete",
    )?.[0] as
      | {
          params?: {
            key?: string;
            deleteTranscript?: boolean;
            emitLifecycleHooks?: boolean;
          };
        }
      | undefined;

    expect(deleteCall?.params).toMatchObject({
      deleteTranscript: true,
      emitLifecycleHooks: false,
      key: result.childSessionKey,
    });
  });

  it("keeps lifecycle hooks enabled when registerSubagentRun fails after thread binding succeeds", async () => {
    hoisted.hookRunner.hasHooks.mockImplementation((name?: string) => name === "subagent_spawning");
    hoisted.hookRunner.runSubagentSpawning.mockResolvedValue({
      status: "ok",
      threadBindingReady: true,
    });
    hoisted.registerSubagentRunMock.mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    hoisted.callGatewayMock.mockImplementation(
      async (request: {
        method?: string;
        params?: { key?: string; deleteTranscript?: boolean; emitLifecycleHooks?: boolean };
      }) => {
        if (request.method === "sessions.patch") {
          return { ok: true };
        }
        if (request.method === "agent") {
          return { runId: "run-thread-register-fail" };
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        mode: "session",
        task: "fail after register with thread binding",
        thread: true,
      },
      {
        agentAccountId: "acct-1",
        agentChannel: "discord",
        agentSessionKey: "agent:main:main",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result).toMatchObject({
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      error: "Failed to register subagent run: registry unavailable",
      runId: "run-thread-register-fail",
      status: "error",
    });

    const deleteCall = hoisted.callGatewayMock.mock.calls.findLast(
      ([request]) => (request as { method?: string }).method === "sessions.delete",
    )?.[0] as
      | {
          params?: {
            key?: string;
            deleteTranscript?: boolean;
            emitLifecycleHooks?: boolean;
          };
        }
      | undefined;

    expect(deleteCall?.params).toMatchObject({
      deleteTranscript: true,
      emitLifecycleHooks: true,
      key: result.childSessionKey,
    });
  });
});
