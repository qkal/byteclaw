import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createRunningTaskRun } from "../tasks/task-executor.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { flowsCancelCommand, flowsListCommand, flowsShowCommand } from "./flows.js";

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: vi.fn(() => ({})),
  };
});

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  } as unknown as RuntimeEnv;
}

async function withTaskFlowCommandStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withTempDir({ prefix: "openclaw-flows-command-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      await run(root);
    } finally {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

describe("flows commands", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("lists TaskFlows as JSON with linked tasks and summaries", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        blockedSummary: "Waiting on child task",
        controllerId: "tests/flows-command",
        createdAt: 100,
        goal: "Inspect a PR cluster",
        ownerKey: "agent:main:main",
        status: "blocked",
        updatedAt: 100,
      });

      createRunningTaskRun({
        childSessionKey: "agent:main:child",
        label: "Inspect PR 123",
        lastEventAt: 100,
        ownerKey: "agent:main:main",
        parentFlowId: flow.flowId,
        runId: "run-child-1",
        runtime: "acp",
        scopeKind: "session",
        startedAt: 100,
        task: "Inspect PR 123",
      });

      const runtime = createRuntime();
      await flowsListCommand({ json: true, status: "blocked" }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        count: number;
        status: string | null;
        flows: {
          flowId: string;
          tasks: { runId?: string; label?: string }[];
          taskSummary: { total: number; active: number };
        }[];
      };

      expect(payload).toMatchObject({
        count: 1,
        flows: [
          {
            flowId: flow.flowId,
            taskSummary: {
              active: 1,
              total: 1,
            },
            tasks: [
              {
                label: "Inspect PR 123",
                runId: "run-child-1",
              },
            ],
          },
        ],
        status: "blocked",
      });
    });
  });

  it("shows one TaskFlow with linked task details in text mode", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        blockedSummary: "Waiting on child task output",
        controllerId: "tests/flows-command",
        createdAt: 100,
        currentStep: "spawn_child",
        goal: "Investigate a flaky queue",
        ownerKey: "agent:main:main",
        status: "blocked",
        updatedAt: 100,
      });

      createRunningTaskRun({
        childSessionKey: "agent:main:child",
        label: "Collect logs",
        lastEventAt: 100,
        ownerKey: "agent:main:main",
        parentFlowId: flow.flowId,
        runId: "run-child-2",
        runtime: "subagent",
        scopeKind: "session",
        startedAt: 100,
        task: "Collect logs",
      });

      const runtime = createRuntime();
      await flowsShowCommand({ json: false, lookup: flow.flowId }, runtime);

      const output = vi
        .mocked(runtime.log)
        .mock.calls.map(([line]) => String(line))
        .join("\n");
      expect(output).toContain("TaskFlow:");
      expect(output).toContain(`flowId: ${flow.flowId}`);
      expect(output).toContain("status: blocked");
      expect(output).toContain("goal: Investigate a flaky queue");
      expect(output).toContain("currentStep: spawn_child");
      expect(output).toContain("owner: agent:main:main");
      expect(output).toContain("state: Waiting on child task output");
      expect(output).toContain("Linked tasks:");
      expect(output).toContain("run-child-2");
      expect(output).toContain("Collect logs");
      expect(output).not.toContain("syncMode:");
      expect(output).not.toContain("controllerId:");
      expect(output).not.toContain("revision:");
      expect(output).not.toContain("blockedTaskId:");
      expect(output).not.toContain("blockedSummary:");
      expect(output).not.toContain("wait:");
    });
  });

  it("sanitizes TaskFlow text output before printing to the terminal", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const unsafeOwnerKey = "agent:main:\u001b[31mowner";
      const flow = createManagedTaskFlow({
        blockedSummary: "Waiting\u001b[31m on child\nforged: yes",
        controllerId: "tests/flows-command",
        createdAt: 100,
        currentStep: "spawn\u001b[2K_child",
        goal: "Investigate\nqueue\tstate",
        ownerKey: unsafeOwnerKey,
        status: "blocked",
        updatedAt: 100,
      });

      createRunningTaskRun({
        childSessionKey: "agent:main:child",
        label: "Collect\nlogs\u001b[2K",
        lastEventAt: 100,
        ownerKey: unsafeOwnerKey,
        parentFlowId: flow.flowId,
        runId: "run-child-3",
        runtime: "subagent",
        scopeKind: "session",
        startedAt: 100,
        task: "Collect logs",
      });

      const runtime = createRuntime();
      await flowsShowCommand({ json: false, lookup: flow.flowId }, runtime);

      const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
      expect(lines).toContain(String.raw`goal: Investigate\nqueue\tstate`);
      expect(lines).toContain("currentStep: spawn_child");
      expect(lines).toContain("owner: agent:main:owner");
      expect(lines).toContain(String.raw`state: Waiting on child\nforged: yes`);
      expect(
        lines.some((line) => line.includes("run-child-3") && line.includes(String.raw`Collect\nlogs`)),
      ).toBe(true);
      expect(lines.join("\n")).not.toContain("\u001b[");
    });
  });

  it("cancels a managed TaskFlow with no active children", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        controllerId: "tests/flows-command",
        createdAt: 100,
        goal: "Stop detached work",
        ownerKey: "agent:main:main",
        status: "running",
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsCancelCommand({ lookup: flow.flowId }, runtime);

      expect(vi.mocked(runtime.error)).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.exit)).not.toHaveBeenCalled();
      expect(String(vi.mocked(runtime.log).mock.calls[0]?.[0])).toContain("Cancelled");
      expect(String(vi.mocked(runtime.log).mock.calls[0]?.[0])).toContain(flow.flowId);
      expect(String(vi.mocked(runtime.log).mock.calls[0]?.[0])).toContain("cancelled");
    });
  });
});
