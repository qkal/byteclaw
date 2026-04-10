import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  emitSessionLifecycleEventMock: vi.fn(),
  pruneLegacyStoreKeysMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: {
        workspace: os.tmpdir(),
      },
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

describe("spawnSubagentDirect seam flow", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      loadConfig: () => hoisted.configOverride,
      pruneLegacyStoreKeysMock: hoisted.pruneLegacyStoreKeysMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      resetModules: false,
      resolveAgentConfig: () => undefined,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.pruneLegacyStoreKeysMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);

    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  it("accepts a spawned run across session patching, runtime-model persistence, registry registration, and lifecycle emission", async () => {
    const operations: string[] = [];
    let persistedStore: Record<string, Record<string, unknown>> | undefined;

    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      operations.push(`gateway:${request.method ?? "unknown"}`);
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
      operations,
    });

    const result = await spawnSubagentDirect(
      {
        model: "openai-codex/gpt-5.4",
        task: "inspect the spawn seam",
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
      mode: "run",
      modelApplied: true,
      runId: "run-1",
      status: "accepted",
    });
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSessionKey = result.childSessionKey as string;
    expect(hoisted.pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(1);
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey,
        cleanup: "keep",
        expectsCompletionMessage: true,
        model: "openai-codex/gpt-5.4",
        requesterDisplayKey: "agent:main:main",
        requesterOrigin: {
          accountId: "acct-1",
          channel: "discord",
          threadId: undefined,
          to: "user-1",
        },
        requesterSessionKey: "agent:main:main",
        runId: "run-1",
        spawnMode: "run",
        task: "inspect the spawn seam",
        workspaceDir: "/tmp/requester-workspace",
      }),
    );
    expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledWith({
      label: undefined,
      parentSessionKey: "agent:main:main",
      reason: "create",
      sessionKey: childSessionKey,
    });

    expectPersistedRuntimeModel({
      model: "gpt-5.4",
      persistedStore,
      provider: "openai-codex",
      sessionKey: childSessionKey,
    });
    expect(operations.indexOf("gateway:sessions.patch")).toBeGreaterThan(-1);
    expect(operations.indexOf("store:update")).toBeGreaterThan(
      operations.indexOf("gateway:sessions.patch"),
    );
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(operations.indexOf("store:update"));
  });

  it("pins admin-only methods to operator.admin and preserves least-privilege for others (#59428)", async () => {
    const capturedCalls: { method?: string; scopes?: string[] }[] = [];

    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; scopes?: string[] }) => {
        capturedCalls.push({ method: request.method, scopes: request.scopes });
        if (request.method === "agent") {
          return { runId: "run-1" };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        model: "openai-codex/gpt-5.4",
        task: "verify per-method scope routing",
      },
      {
        agentAccountId: "acct-1",
        agentChannel: "discord",
        agentSessionKey: "agent:main:main",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    expect(capturedCalls.length).toBeGreaterThan(0);

    for (const call of capturedCalls) {
      if (call.method === "sessions.patch" || call.method === "sessions.delete") {
        // Admin-only methods must be pinned to operator.admin.
        expect(call.scopes).toEqual(["operator.admin"]);
      } else {
        // Non-admin methods (e.g. "agent") must NOT be forced to admin scope
        // So the gateway preserves least-privilege and senderIsOwner stays false.
        expect(call.scopes).toBeUndefined();
      }
    }
  });

  it("forwards normalized thinking to the agent run", async () => {
    const calls: { method?: string; params?: unknown }[] = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { acceptedAt: 1000, runId: "run-thinking", status: "accepted" };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify thinking forwarding",
        thinking: "high",
      },
      {
        agentChannel: "discord",
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
    });
    const agentCall = calls.find((call) => call.method === "agent");
    expect(agentCall?.params).toMatchObject({
      thinking: "high",
    });
  });

  it("returns an error when the initial model patch is rejected", async () => {
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        if (request.method === "sessions.patch") {
          const model = (request.params as { model?: unknown } | undefined)?.model;
          if (model === "bad-model") {
            throw new Error("invalid model: bad-model");
          }
          return { ok: true };
        }
        if (request.method === "agent") {
          return { acceptedAt: 1000, runId: "run-1", status: "accepted" };
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        model: "bad-model",
        task: "verify patch rejection",
      },
      {
        agentChannel: "discord",
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result).toMatchObject({
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      status: "error",
    });
    expect(String(result.error ?? "")).toContain("invalid model");
    expect(
      hoisted.callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });
});
