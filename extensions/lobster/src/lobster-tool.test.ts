import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../runtime-api.js";
import { createLobsterTool } from "./lobster-tool.js";
import { createFakeTaskFlow } from "./taskflow-test-helpers.js";

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "lobster",
    name: "lobster",
    resolvePath: (p) => p,
    runtime: { version: "test" } as any,
    source: "test",
    ...overrides,
  });
}

function fakeCtx(overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext {
  return {
    agentAccountId: undefined,
    agentDir: "/tmp",
    agentId: "main",
    config: {},
    messageChannel: undefined,
    sandboxed: false,
    sessionKey: "main",
    workspaceDir: "/tmp",
    ...overrides,
  };
}

describe("lobster plugin tool", () => {
  it("returns the Lobster envelope in details", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        output: [{ hello: "world" }],
        requiresApproval: null,
        status: "ok",
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call1", {
      action: "run",
      pipeline: "noop",
      timeoutMs: 1000,
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      cwd: process.cwd(),
      maxStdoutBytes: 512_000,
      pipeline: "noop",
      timeoutMs: 1000,
    });
    expect(res.details).toMatchObject({
      ok: true,
      output: [{ hello: "world" }],
      requiresApproval: null,
      status: "ok",
    });
  });

  it("supports approval envelopes without changing the tool contract", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        output: [],
        requiresApproval: {
          items: [{ id: "alert-1" }],
          prompt: "Send these alerts?",
          resumeToken: "resume-token-1",
          type: "approval_request",
        },
        status: "needs_approval",
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call-injected-runner", {
      action: "run",
      argsJson: '{"since_hours":1}',
      maxStdoutBytes: 4096,
      pipeline: "noop",
      timeoutMs: 1500,
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      argsJson: '{"since_hours":1}',
      cwd: process.cwd(),
      maxStdoutBytes: 4096,
      pipeline: "noop",
      timeoutMs: 1500,
    });
    expect(res.details).toMatchObject({
      ok: true,
      requiresApproval: {
        prompt: "Send these alerts?",
        resumeToken: "resume-token-1",
        type: "approval_request",
      },
      status: "needs_approval",
    });
  });

  it("throws when the runner returns an error envelope", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: {
        run: vi.fn().mockResolvedValue({
          error: {
            message: "boom",
            type: "runtime_error",
          },
          ok: false,
        }),
      },
    });

    await expect(
      tool.execute("call-runner-error", {
        action: "run",
        pipeline: "noop",
      }),
    ).rejects.toThrow("boom");
  });

  it("can run through managed TaskFlow mode", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        output: [],
        requiresApproval: {
          items: [{ id: "item-1" }],
          prompt: "Approve this?",
          resumeToken: "resume-1",
          type: "approval_request",
        },
        status: "needs_approval",
      }),
    };
    const taskFlow = createFakeTaskFlow();

    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    const res = await tool.execute("call-managed-run", {
      action: "run",
      flowControllerId: "tests/lobster",
      flowCurrentStep: "run_lobster",
      flowGoal: "Run Lobster workflow",
      flowStateJson: '{"lane":"email"}',
      flowWaitingStep: "await_review",
      pipeline: "noop",
    });

    expect(taskFlow.createManaged).toHaveBeenCalledWith({
      controllerId: "tests/lobster",
      currentStep: "run_lobster",
      goal: "Run Lobster workflow",
      stateJson: { lane: "email" },
    });
    expect(taskFlow.setWaiting).toHaveBeenCalledWith({
      currentStep: "await_review",
      expectedRevision: 1,
      flowId: "flow-1",
      waitJson: {
        items: [{ id: "item-1" }],
        kind: "lobster_approval",
        prompt: "Approve this?",
        resumeToken: "resume-1",
      },
    });
    expect(res.details).toMatchObject({
      flow: {
        flowId: "flow-1",
      },
      mutation: {
        applied: true,
      },
      ok: true,
      status: "needs_approval",
    });
  });

  it("rejects managed TaskFlow params when no bound taskFlow runtime is available", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });

    await expect(
      tool.execute("call-missing-taskflow", {
        action: "run",
        flowControllerId: "tests/lobster",
        flowGoal: "Run Lobster workflow",
        pipeline: "noop",
      }),
    ).rejects.toThrow(/Managed TaskFlow run mode requires a bound taskFlow runtime/);
  });

  it("rejects invalid flowStateJson in managed TaskFlow mode", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-invalid-flow-json", {
        action: "run",
        flowControllerId: "tests/lobster",
        flowGoal: "Run Lobster workflow",
        flowStateJson: "{bad",
        pipeline: "noop",
      }),
    ).rejects.toThrow(/flowStateJson must be valid JSON/);
  });

  it("rejects managed TaskFlow resume mode without a token", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-missing-resume-token", {
        action: "resume",
        approve: true,
        flowExpectedRevision: 1,
        flowId: "flow-1",
      }),
    ).rejects.toThrow(/token required when using managed TaskFlow resume mode/);
  });

  it("rejects managed TaskFlow resume mode without approve", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-missing-resume-approve", {
        action: "resume",
        flowExpectedRevision: 1,
        flowId: "flow-1",
        token: "resume-token",
      }),
    ).rejects.toThrow(/approve required when using managed TaskFlow resume mode/);
  });

  it("requires action", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(tool.execute("call-action-missing", {})).rejects.toThrow(/action required/);
  });

  it("rejects unknown action", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-action-unknown", {
        action: "explode",
      }),
    ).rejects.toThrow(/Unknown action/);
  });

  it("rejects absolute cwd", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-absolute-cwd", {
        action: "run",
        cwd: "/tmp",
        pipeline: "noop",
      }),
    ).rejects.toThrow(/cwd must be a relative path/);
  });

  it("rejects cwd that escapes the gateway working directory", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-escape-cwd", {
        action: "run",
        cwd: "../../etc",
        pipeline: "noop",
      }),
    ).rejects.toThrow(/must stay within/);
  });

  it("can be gated off in sandboxed contexts", async () => {
    const api = fakeApi();
    const factoryTool = (ctx: OpenClawPluginToolContext) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api, {
        runner: { run: vi.fn() },
      });
    };

    expect(factoryTool(fakeCtx({ sandboxed: true }))).toBeNull();
    expect(factoryTool(fakeCtx({ sandboxed: false }))?.name).toBe("lobster");
  });
});
