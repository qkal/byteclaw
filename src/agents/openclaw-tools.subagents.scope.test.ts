import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  callGatewayMock,
  resetSubagentsConfigOverride,
  setSubagentsConfigOverride,
} from "./openclaw-tools.subagents.test-harness.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "./subagent-registry.js";
import "./test-helpers/fast-core-tools.js";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";

function writeStore(storePath: string, store: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

function seedLeafOwnedChildSession(storePath: string, leafKey = "agent:main:subagent:leaf") {
  const childKey = `${leafKey}:subagent:child`;
  writeStore(storePath, {
    [leafKey]: {
      sessionId: "leaf-session",
      spawnedBy: "agent:main:main",
      subagentControlScope: "none",
      subagentRole: "leaf",
      updatedAt: Date.now(),
    },
    [childKey]: {
      sessionId: "child-session",
      spawnedBy: leafKey,
      subagentControlScope: "none",
      subagentRole: "leaf",
      updatedAt: Date.now(),
    },
  });

  addSubagentRunForTests({
    childSessionKey: childKey,
    cleanup: "keep",
    controllerSessionKey: leafKey,
    createdAt: Date.now() - 30_000,
    requesterDisplayKey: leafKey,
    requesterSessionKey: leafKey,
    runId: "run-child",
    startedAt: Date.now() - 30_000,
    task: "impossible child",
  });

  return {
    childKey,
    tool: createSubagentsTool({ agentSessionKey: leafKey }),
  };
}

async function expectLeafSubagentControlForbidden(params: {
  storePath: string;
  action: "kill" | "steer";
  callId: string;
  message?: string;
}) {
  const { childKey, tool } = seedLeafOwnedChildSession(params.storePath);
  const result = await tool.execute(params.callId, {
    action: params.action,
    target: childKey,
    ...(params.message ? { message: params.message } : {}),
  });

  expect(result.details).toMatchObject({
    error: "Leaf subagents cannot control other sessions.",
    status: "forbidden",
  });
  expect(callGatewayMock).not.toHaveBeenCalled();
}

describe("openclaw-tools: subagents scope isolation", () => {
  let storePath = "";

  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetSubagentsConfigOverride();
    callGatewayMock.mockReset();
    storePath = path.join(
      os.tmpdir(),
      `openclaw-subagents-scope-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    setSubagentsConfigOverride({
      session: createPerSenderSessionConfig({ store: storePath }),
    });
    writeStore(storePath, {});
  });

  it("leaf subagents do not inherit parent sibling control scope", async () => {
    const leafKey = "agent:main:subagent:leaf";
    const siblingKey = "agent:main:subagent:unsandboxed";

    writeStore(storePath, {
      [leafKey]: {
        sessionId: "leaf-session",
        spawnedBy: "agent:main:main",
        updatedAt: Date.now(),
      },
      [siblingKey]: {
        sessionId: "sibling-session",
        spawnedBy: "agent:main:main",
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      childSessionKey: leafKey,
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-leaf",
      startedAt: Date.now() - 30_000,
      task: "sandboxed leaf",
    });
    addSubagentRunForTests({
      childSessionKey: siblingKey,
      cleanup: "keep",
      createdAt: Date.now() - 20_000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-sibling",
      startedAt: Date.now() - 20_000,
      task: "unsandboxed sibling",
    });

    const tool = createSubagentsTool({ agentSessionKey: leafKey });
    const result = await tool.execute("call-leaf-list", { action: "list" });

    expect(result.details).toMatchObject({
      active: [],
      callerIsSubagent: true,
      callerSessionKey: leafKey,
      recent: [],
      requesterSessionKey: leafKey,
      status: "ok",
      total: 0,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("orchestrator subagents still see children they spawned", async () => {
    const orchestratorKey = "agent:main:subagent:orchestrator";
    const workerKey = `${orchestratorKey}:subagent:worker`;
    const siblingKey = "agent:main:subagent:sibling";

    writeStore(storePath, {
      [orchestratorKey]: {
        sessionId: "orchestrator-session",
        spawnedBy: "agent:main:main",
        updatedAt: Date.now(),
      },
      [workerKey]: {
        sessionId: "worker-session",
        spawnedBy: orchestratorKey,
        updatedAt: Date.now(),
      },
      [siblingKey]: {
        sessionId: "sibling-session",
        spawnedBy: "agent:main:main",
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      childSessionKey: workerKey,
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      requesterDisplayKey: orchestratorKey,
      requesterSessionKey: orchestratorKey,
      runId: "run-worker",
      startedAt: Date.now() - 30_000,
      task: "worker child",
    });
    addSubagentRunForTests({
      childSessionKey: siblingKey,
      cleanup: "keep",
      createdAt: Date.now() - 20_000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-sibling",
      startedAt: Date.now() - 20_000,
      task: "sibling of orchestrator",
    });

    const tool = createSubagentsTool({ agentSessionKey: orchestratorKey });
    const result = await tool.execute("call-orchestrator-list", { action: "list" });
    const details = result.details as {
      status?: string;
      requesterSessionKey?: string;
      total?: number;
      active?: { sessionKey?: string }[];
    };

    expect(details.status).toBe("ok");
    expect(details.requesterSessionKey).toBe(orchestratorKey);
    expect(details.total).toBe(1);
    expect(details.active).toEqual([
      expect.objectContaining({
        sessionKey: workerKey,
      }),
    ]);
  });

  it("leaf subagents cannot kill even explicitly-owned child sessions", async () => {
    await expectLeafSubagentControlForbidden({
      action: "kill",
      callId: "call-leaf-kill",
      storePath,
    });
  });

  it("leaf subagents cannot steer even explicitly-owned child sessions", async () => {
    await expectLeafSubagentControlForbidden({
      action: "steer",
      callId: "call-leaf-steer",
      message: "continue",
      storePath,
    });
  });
});
