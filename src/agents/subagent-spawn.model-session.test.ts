import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const pruneLegacyStoreKeysMock = vi.fn();

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

describe("spawnSubagentDirect runtime model persistence", () => {
  beforeEach(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      loadConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      pruneLegacyStoreKeysMock,
      updateSessionStoreMock,
      workspaceDir: os.tmpdir(),
    }));
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
    pruneLegacyStoreKeysMock.mockReset();
    setupAcceptedSubagentGatewayMock(callGatewayMock);

    updateSessionStoreMock.mockImplementation(
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

  it("persists runtime model fields on the child session before starting the run", async () => {
    const operations: string[] = [];
    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      operations.push(`gateway:${opts.method ?? "unknown"}`);
      if (opts.method === "sessions.patch") {
        return { ok: true };
      }
      if (opts.method === "agent") {
        return { acceptedAt: 1000, runId: "run-1", status: "accepted" };
      }
      if (opts.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
      operations,
    });

    const result = await spawnSubagentDirect(
      {
        model: "openai-codex/gpt-5.4",
        task: "test",
      },
      {
        agentChannel: "discord",
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result).toMatchObject({
      modelApplied: true,
      status: "accepted",
    });
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
    expectPersistedRuntimeModel({
      model: "gpt-5.4",
      persistedStore,
      provider: "openai-codex",
      sessionKey: /^agent:main:subagent:/,
    });
    expect(pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(1);
    expect(operations.indexOf("gateway:sessions.patch")).toBeGreaterThan(-1);
    expect(operations.indexOf("store:update")).toBeGreaterThan(
      operations.indexOf("gateway:sessions.patch"),
    );
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(operations.indexOf("store:update"));
  });
});
