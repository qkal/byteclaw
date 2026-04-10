import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { buildSystemRunPreparePayload } from "../test-utils/system-run-prepare-payload.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: vi.fn(async () => [
    { commands: ["system.run"], nodeId: "node-1", platform: "darwin" },
  ]),
  resolveNodeIdFromList: vi.fn((nodes: { nodeId: string }[]) => nodes[0]?.nodeId),
}));

vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let sendMessage: typeof import("../infra/outbound/message.js").sendMessage;

function buildPreparedSystemRunPayload(rawInvokeParams: unknown) {
  const invoke = (rawInvokeParams ?? {}) as {
    params?: {
      command?: unknown;
      rawCommand?: unknown;
      cwd?: unknown;
      agentId?: unknown;
      sessionKey?: unknown;
    };
  };
  const params = invoke.params ?? {};
  return buildSystemRunPreparePayload(params);
}

async function writeExecApprovalsConfig(config: Record<string, unknown>) {
  const approvalsPath = path.join(process.env.HOME ?? "", ".openclaw", "exec-approvals.json");
  await fs.mkdir(path.dirname(approvalsPath), { recursive: true });
  await fs.writeFile(approvalsPath, JSON.stringify(config, null, 2));
}

function acceptedApprovalResponse(params: unknown) {
  return { id: (params as { id?: string })?.id, status: "accepted" };
}

function getResultText(result: { content: { type?: string; text?: string }[] }) {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function expectPendingApprovalText(
  result: {
    details: { status?: string };
    content: { type?: string; text?: string }[];
  },
  options: {
    command: string;
    host: "gateway" | "node";
    nodeId?: string;
    interactive?: boolean;
    allowedDecisions?: string;
    cwdText?: string;
  },
) {
  expect(result.details.status).toBe("approval-pending");
  const details = result.details as { approvalId: string; approvalSlug: string };
  const pendingText = getResultText(result);
  expect(pendingText).toContain(
    `Reply with: /approve ${details.approvalSlug} ${options.allowedDecisions ?? "allow-once|allow-always|deny"}`,
  );
  expect(pendingText).toContain(`full ${details.approvalId}`);
  expect(pendingText).toContain(`Host: ${options.host}`);
  if (options.nodeId) {
    expect(pendingText).toContain(`Node: ${options.nodeId}`);
  }
  expect(pendingText).toContain(`CWD: ${options.cwdText ?? process.cwd()}`);
  expect(pendingText).toContain("Command:\n```sh\n");
  expect(pendingText).toContain(options.command);
  if (options.interactive) {
    expect(pendingText).toContain("Mode: foreground (interactive approvals available).");
    expect(pendingText).toContain(
      (options.allowedDecisions ?? "").includes("allow-always")
        ? "Background mode requires pre-approved policy"
        : "Background mode requires an effective policy that allows pre-approval",
    );
  }
  return details;
}

function expectPendingCommandText(
  result: {
    details: { status?: string };
    content: { type?: string; text?: string }[];
  },
  command: string,
) {
  expect(result.details.status).toBe("approval-pending");
  const text = getResultText(result);
  expect(text).toContain("Command:\n```sh\n");
  expect(text).toContain(command);
}

function mockGatewayOkCalls(calls: string[]) {
  vi.mocked(callGatewayTool).mockImplementation(async (method) => {
    calls.push(method);
    return { ok: true };
  });
}

function createElevatedAllowlistExecTool() {
  return createExecTool({
    approvalRunningNoticeMs: 0,
    ask: "on-miss",
    elevated: { allowed: true, defaultLevel: "ask", enabled: true },
    security: "allowlist",
  });
}

async function expectGatewayExecWithoutApproval(options: {
  config: Record<string, unknown>;
  command: string;
  ask?: "always" | "on-miss" | "off";
  security?: "allowlist" | "full";
}) {
  await writeExecApprovalsConfig(options.config);
  const calls: string[] = [];
  mockGatewayOkCalls(calls);

  const tool = createExecTool({
    approvalRunningNoticeMs: 0,
    ask: options.ask,
    host: "gateway",
    security: options.security,
  });

  const result = await tool.execute("call-no-approval", { command: options.command });
  expect(result.details.status).toBe("completed");
  expect(calls).not.toContain("exec.approval.request");
  expect(calls).not.toContain("exec.approval.waitDecision");
}

async function expectGatewayAskAlwaysPrompt(options: {
  turnId: string;
  command?: string;
  allowlist?: { pattern: string; source?: "allow-always" }[];
}) {
  await writeExecApprovalsConfig({
    agents: {
      main: options.allowlist ? { allowlist: options.allowlist } : {},
    },
    defaults: { ask: "always", askFallback: "full", security: "full" },
    version: 1,
  });
  mockPendingApprovalRegistration();

  const tool = createExecTool({
    approvalRunningNoticeMs: 0,
    ask: "always",
    host: "gateway",
    security: "full",
  });

  return await tool.execute(options.turnId, {
    command: options.command ?? `${JSON.stringify(process.execPath)} --version`,
  });
}

function mockAcceptedApprovalFlow(options: {
  onAgent?: (params: Record<string, unknown>) => void;
  onNodeInvoke?: (params: unknown) => unknown;
}) {
  vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
    if (method === "exec.approval.request") {
      return acceptedApprovalResponse(params);
    }
    if (method === "exec.approval.waitDecision") {
      return { decision: "allow-once" };
    }
    if (method === "agent" && options.onAgent) {
      options.onAgent(params as Record<string, unknown>);
      return { status: "ok" };
    }
    if (method === "node.invoke" && options.onNodeInvoke) {
      return await options.onNodeInvoke(params);
    }
    return { ok: true };
  });
}

function mockPendingApprovalRegistration() {
  vi.mocked(callGatewayTool).mockImplementation(async (method) => {
    if (method === "exec.approval.request") {
      return { id: "approval-id", status: "accepted" };
    }
    if (method === "exec.approval.waitDecision") {
      return { decision: null };
    }
    return { ok: true };
  });
}

function mockNoApprovalRouteRegistration() {
  vi.mocked(callGatewayTool).mockImplementation(async (method) => {
    if (method === "exec.approval.request") {
      return { decision: null, id: "approval-id" };
    }
    if (method === "exec.approval.waitDecision") {
      return { decision: null };
    }
    return { ok: true };
  });
}

describe("exec approvals", () => {
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousBundledPluginsDir: string | undefined;
  let previousDisableBundledPlugins: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    previousDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    process.env.HOME = tempDir;
    // Windows uses USERPROFILE for os.homedir()
    process.env.USERPROFILE = tempDir;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ createExecTool } = await import("./bash-tools.exec.js"));
    ({ sendMessage } = await import("../infra/outbound/message.js"));
    vi.mocked(callGatewayTool).mockReset();
    vi.mocked(sendMessage).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    if (previousBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
    }
    if (previousDisableBundledPlugins === undefined) {
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    } else {
      process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundledPlugins;
    }
  });

  it("reuses approval id as the node runId", async () => {
    let invokeParams: unknown;
    let agentParams: unknown;

    mockAcceptedApprovalFlow({
      onAgent: (params) => {
        agentParams = params;
      },
      onNodeInvoke: (params) => {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          invokeParams = params;
          return { payload: { stdout: "ok", success: true } };
        }
      },
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "always",
      host: "node",
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", { command: "ls -la" });
    const details = expectPendingApprovalText(result, {
      allowedDecisions: "allow-once|deny",
      command: "ls -la",
      cwdText: "(node default)",
      host: "node",
      interactive: true,
      nodeId: "node-1",
    });
    const {approvalId} = details;

    await expect
      .poll(() => (invokeParams as { params?: { runId?: string } } | undefined)?.params?.runId, {
        interval: 20,
        timeout: 2000,
      })
      .toBe(approvalId);
    expect(
      (invokeParams as { params?: { suppressNotifyOnExit?: boolean } } | undefined)?.params,
    ).toMatchObject({
      suppressNotifyOnExit: true,
    });
    await expect.poll(() => agentParams, { interval: 20, timeout: 2000 }).toBeTruthy();
  });

  it("skips approval when node allowlist is satisfied", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-bin-"));
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const exeName = process.platform === "win32" ? "tool.cmd" : "tool";
    const exePath = path.join(binDir, exeName);
    await fs.writeFile(exePath, "");
    if (process.platform !== "win32") {
      await fs.chmod(exePath, 0o755);
    }
    const approvalsFile = {
      agents: {
        main: {
          allowlist: [{ pattern: exePath }],
        },
      },
      defaults: { ask: "on-miss", askFallback: "deny", security: "allowlist" },
      version: 1,
    };

    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approvals.node.get") {
        return { file: approvalsFile };
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        return { payload: { stdout: "ok", success: true } };
      }
      // Exec.approval.request should NOT be called when allowlist is satisfied
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "on-miss",
      host: "node",
      security: "allowlist",
    });

    const result = await tool.execute("call2", {
      command: `"${exePath}" --help`,
    });
    expect(result.details.status).toBe("completed");
    expect(calls).toContain("exec.approvals.node.get");
    expect(calls).toContain("node.invoke");
    expect(calls).not.toContain("exec.approval.request");
  });

  it("preserves explicit workdir for node exec", async () => {
    const remoteWorkdir = "/Users/vv";
    let prepareCwd: string | undefined;

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "node.invoke") {
        const invoke = params as { command?: string; params?: { cwd?: string } };
        if (invoke.command === "system.run.prepare") {
          prepareCwd = invoke.params?.cwd;
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          return { payload: { stdout: "ok", success: true } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "off",
      host: "node",
      security: "full",
    });

    const result = await tool.execute("call-node-cwd", {
      command: "/bin/pwd",
      workdir: remoteWorkdir,
    });

    expect(result.details.status).toBe("completed");
    expect(prepareCwd).toBe(remoteWorkdir);
  });

  it("does not forward the gateway default cwd to node exec when workdir is omitted", async () => {
    const gatewayWorkspace = "/gateway/workspace";
    let prepareHasCwd = false;
    let prepareCwd: string | undefined;

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "node.invoke") {
        const invoke = params as { command?: string; params?: { cwd?: string } };
        if (invoke.command === "system.run.prepare") {
          prepareHasCwd = Object.hasOwn(invoke.params ?? {}, "cwd");
          prepareCwd = invoke.params?.cwd;
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          return { payload: { stdout: "ok", success: true } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "off",
      cwd: gatewayWorkspace,
      host: "node",
      security: "full",
    });

    const result = await tool.execute("call-node-default-cwd", {
      command: "/bin/pwd",
    });

    expect(result.details.status).toBe("completed");
    expect(prepareHasCwd).toBe(false);
    expect(prepareCwd).toBeUndefined();
  });

  it("routes explicit host=node to node invoke when elevated default is on under auto host", async () => {
    const calls: string[] = [];

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          return { payload: { stdout: "node-ok", success: true } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "off",
      elevated: { allowed: true, defaultLevel: "on", enabled: true },
      host: "auto",
      security: "full",
    });

    const result = await tool.execute("call-auto-node-elevated-default", {
      command: "echo gateway-ok",
      host: "node",
    });

    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("node-ok");
    expect(calls).toContain("node.invoke");
  });

  it("honors ask=off for elevated gateway exec without prompting", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "off",
      elevated: { allowed: true, defaultLevel: "ask", enabled: true },
      security: "full",
    });

    const result = await tool.execute("call3", { command: "echo ok", elevated: true });
    expect(result.details.status).toBe("completed");
    expect(calls).not.toContain("exec.approval.request");
  });

  it("uses exec-approvals ask=off to suppress gateway prompts", async () => {
    await expectGatewayExecWithoutApproval({
      ask: "on-miss",
      command: "echo ok",
      config: {
        agents: {
          main: { ask: "off", askFallback: "full", security: "full" },
        },
        defaults: { ask: "off", askFallback: "full", security: "full" },
        version: 1,
      },
    });
  });

  it("inherits ask=off from exec-approvals defaults when tool ask is unset", async () => {
    await expectGatewayExecWithoutApproval({
      command: "echo ok",
      config: {
        agents: {},
        defaults: { ask: "off", askFallback: "full", security: "full" },
        version: 1,
      },
    });
  });

  it("inherits security=full from exec-approvals defaults when tool security is unset", async () => {
    await expectGatewayExecWithoutApproval({
      command: "echo ok",
      config: {
        agents: {},
        defaults: { ask: "off", askFallback: "full", security: "full" },
        version: 1,
      },
      security: undefined,
    });
  });

  it("keeps ask=always prompts even when durable allow-always trust matches", async () => {
    const result = await expectGatewayAskAlwaysPrompt({
      allowlist: [{ pattern: process.execPath, source: "allow-always" }],
      turnId: "call-gateway-durable-still-prompts",
    });

    expect(result.details.status).toBe("approval-pending");
    expect(result.details).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(getResultText(result)).toContain("Reply with: /approve ");
    expect(getResultText(result)).toContain("allow-once|deny");
    expect(getResultText(result)).not.toContain("allow-once|allow-always|deny");
    expect(getResultText(result)).toContain("Allow Always is unavailable");
  });

  it("keeps ask=always prompts for static allowlist entries without allow-always trust", async () => {
    const result = await expectGatewayAskAlwaysPrompt({
      allowlist: [{ pattern: process.execPath }],
      turnId: "call-static-allowlist-still-prompts",
    });

    expect(result.details.status).toBe("approval-pending");
  });

  it("reuses gateway allow-always approvals for repeated exact commands", async () => {
    await writeExecApprovalsConfig({
      agents: {},
      defaults: { ask: "on-miss", askFallback: "deny", security: "allowlist" },
      version: 1,
    });
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "allow-always" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "on-miss",
      host: "gateway",
      security: "allowlist",
    });
    const command = `${JSON.stringify(process.execPath)} --version`;

    const first = await tool.execute("call-gateway-allow-always-initial", {
      command,
    });

    expect(first.details.status).toBe("approval-pending");
    expect(calls).toContain("exec.approval.request");
    expect(calls).toContain("exec.approval.waitDecision");

    const approvalsPath = path.join(process.env.HOME ?? "", ".openclaw", "exec-approvals.json");
    await expect
      .poll(async () => {
        const raw = await fs.readFile(approvalsPath, "utf8");
        const parsed = JSON.parse(raw) as {
          agents?: { main?: { allowlist?: { source?: string }[] } };
        };
        return parsed.agents?.main?.allowlist?.some((entry) => entry.source === "allow-always");
      })
      .toBe(true);

    calls.length = 0;

    const second = await tool.execute("call-gateway-allow-always-repeat", {
      command,
    });

    expect(second.details.status).toBe("completed");
    expect(calls).not.toContain("exec.approval.request");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });

  it("keeps ask=always prompts for node-host runs even with durable trust", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approvals.node.get") {
        return {
          file: {
            agents: {
              main: {
                allowlist: [{ pattern: process.execPath, source: "allow-always" }],
              },
            },
            version: 1,
          },
        };
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          return { payload: { stdout: "node-ok", success: true } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "always",
      host: "node",
      security: "full",
    });

    const result = await tool.execute("call-node-durable-allow-always", {
      command: `${JSON.stringify(process.execPath)} --version`,
    });

    expect(result.details.status).toBe("approval-pending");
    expect(result.details).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(calls).toContain("exec.approval.request");
  });

  it("reuses exact-command durable trust for node shell-wrapper reruns", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approvals.node.get") {
        const prepared = buildPreparedSystemRunPayload({
          params: { command: ["/bin/sh", "-lc", "cd ."], cwd: process.cwd() },
        }) as { payload?: { plan?: { commandText?: string } } };
        const commandText = prepared.payload?.plan?.commandText ?? "";
        return {
          file: {
            agents: {
              main: {
                allowlist: [
                  {
                    pattern: `=command:${crypto
                      .createHash("sha256")
                      .update(commandText)
                      .digest("hex")
                      .slice(0, 16)}`,
                    source: "allow-always",
                  },
                ],
              },
            },
            version: 1,
          },
        };
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          return { payload: { stdout: "node-shell-wrapper-ok", success: true } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "on-miss",
      host: "node",
      security: "allowlist",
    });

    const result = await tool.execute("call-node-shell-wrapper-durable-allow-always", {
      command: "cd .",
    });

    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("node-shell-wrapper-ok");
    expect(calls).not.toContain("exec.approval.request");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });

  it("requires approval for elevated ask when allowlist misses", async () => {
    const calls: string[] = [];
    let resolveApproval: (() => void) | undefined;
    const approvalSeen = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        resolveApproval?.();
        // Return registration confirmation
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { ok: true };
    });

    const tool = createElevatedAllowlistExecTool();

    const result = await tool.execute("call4", { command: "echo ok", elevated: true });
    expectPendingApprovalText(result, { command: "echo ok", host: "gateway" });
    await approvalSeen;
    expect(calls).toContain("exec.approval.request");
    expect(calls).toContain("exec.approval.waitDecision");
  });

  it("starts an internal agent follow-up after approved gateway exec completes without an external route", async () => {
    const agentCalls: Record<string, unknown>[] = [];

    mockAcceptedApprovalFlow({
      onAgent: (params) => {
        agentCalls.push(params);
      },
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "always",
      elevated: { allowed: true, defaultLevel: "ask", enabled: true },
      host: "gateway",
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-gw-followup", {
      command: "echo ok",
      workdir: process.cwd(),
    });

    expect(result.details.status).toBe("approval-pending");
    await expect.poll(() => agentCalls.length, { interval: 20, timeout: 3000 }).toBe(1);
    expect(agentCalls[0]).toEqual(
      expect.objectContaining({
        deliver: false,
        idempotencyKey: expect.stringContaining("exec-approval-followup:"),
        sessionKey: "agent:main:main",
      }),
    );
    expect(typeof agentCalls[0]?.message).toBe("string");
    expect(agentCalls[0]?.message).toContain(
      "An async command the user already approved has completed.",
    );
  });

  it("continues the original agent session after approved gateway exec completes with an external route", async () => {
    const agentCalls: Record<string, unknown>[] = [];

    mockAcceptedApprovalFlow({
      onAgent: (params) => {
        agentCalls.push(params);
      },
    });

    const tool = createExecTool({
      accountId: "default",
      approvalRunningNoticeMs: 0,
      ask: "always",
      currentChannelId: "123",
      currentThreadTs: "456",
      elevated: { allowed: true, defaultLevel: "ask", enabled: true },
      host: "gateway",
      messageProvider: "discord",
      sessionKey: "agent:main:discord:channel:123",
    });

    const result = await tool.execute("call-gw-followup-discord", {
      command: "echo ok",
      workdir: process.cwd(),
    });

    expect(result.details.status).toBe("approval-pending");
    await expect.poll(() => agentCalls.length, { interval: 20, timeout: 3000 }).toBe(1);
    expect(agentCalls[0]).toEqual(
      expect.objectContaining({
        accountId: "default",
        bestEffortDeliver: true,
        channel: "discord",
        deliver: true,
        idempotencyKey: expect.stringContaining("exec-approval-followup:"),
        sessionKey: "agent:main:discord:channel:123",
        threadId: "456",
        to: "123",
      }),
    );
    expect(typeof agentCalls[0]?.message).toBe("string");
    expect(agentCalls[0]?.message).toContain(
      "If the task requires more steps, continue from this result before replying to the user.",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("auto-continues the same Discord session after approval resolves without a second user turn", async () => {
    const agentCalls: Record<string, unknown>[] = [];
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-followup-discord-"));
    const markerPath = path.join(tempDir, "marker.txt");
    let resolveDecision: ((value: { decision: string }) => void) | undefined;
    const decisionPromise = new Promise<{ decision: string }>((resolve) => {
      resolveDecision = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return await decisionPromise;
      }
      if (method === "agent") {
        agentCalls.push(params as Record<string, unknown>);
        return { status: "ok" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      accountId: "default",
      approvalRunningNoticeMs: 0,
      ask: "always",
      currentChannelId: "123",
      currentThreadTs: "456",
      elevated: { allowed: true, defaultLevel: "ask", enabled: true },
      host: "gateway",
      messageProvider: "discord",
      sessionKey: "agent:main:discord:channel:123",
    });

    const result = await tool.execute("call-gw-followup-discord-delayed", {
      command: "node -e \"require('node:fs').writeFileSync('marker.txt','ok')\"",
      workdir: tempDir,
    });

    expect(result.details.status).toBe("approval-pending");
    expect(agentCalls).toHaveLength(0);
    await expect
      .poll(
        async () => {
          try {
            await fs.access(markerPath);
            return true;
          } catch {
            return false;
          }
        },
        { interval: 50, timeout: 500 },
      )
      .toBe(false);

    resolveDecision?.({ decision: "allow-once" });

    await expect.poll(() => agentCalls.length, { interval: 20, timeout: 3000 }).toBe(1);
    expect(agentCalls[0]).toEqual(
      expect.objectContaining({
        accountId: "default",
        bestEffortDeliver: true,
        channel: "discord",
        deliver: true,
        sessionKey: "agent:main:discord:channel:123",
        threadId: "456",
        to: "123",
      }),
    );
    expect(typeof agentCalls[0]?.message).toBe("string");
    expect(agentCalls[0]?.message).toContain(
      "If the task requires more steps, continue from this result before replying to the user.",
    );
    expect(sendMessage).not.toHaveBeenCalled();

    await expect
      .poll(
        async () => {
          try {
            return await fs.readFile(markerPath, "utf8");
          } catch {
            return "";
          }
        },
        { interval: 50, timeout: 5000 },
      )
      .toBe("ok");
  });

  it("executes approved commands and emits a session-only followup in webchat-only mode", async () => {
    const agentCalls: Record<string, unknown>[] = [];
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-followup-sidefx-"));
    const markerPath = path.join(tempDir, "marker.txt");

    mockAcceptedApprovalFlow({
      onAgent: (params) => {
        agentCalls.push(params);
      },
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "always",
      elevated: { allowed: true, defaultLevel: "ask", enabled: true },
      host: "gateway",
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-gw-followup-webchat", {
      command: "node -e \"require('node:fs').writeFileSync('marker.txt','ok')\"",
      workdir: tempDir,
    });

    expect(result.details.status).toBe("approval-pending");

    await expect.poll(() => agentCalls.length, { interval: 20, timeout: 3000 }).toBe(1);
    expect(agentCalls[0]).toEqual(
      expect.objectContaining({
        deliver: false,
        sessionKey: "agent:main:main",
      }),
    );

    await expect
      .poll(
        async () => {
          try {
            return await fs.readFile(markerPath, "utf8");
          } catch {
            return "";
          }
        },
        { interval: 50, timeout: 5000 },
      )
      .toBe("ok");
  });

  it("uses a deny-specific followup prompt so prior output is not reused", async () => {
    const agentCalls: Record<string, unknown>[] = [];

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      if (method === "agent") {
        agentCalls.push(params as Record<string, unknown>);
        return { status: "ok" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "always",
      elevated: { allowed: true, defaultLevel: "ask", enabled: true },
      host: "gateway",
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-gw-followup-deny", {
      command: "echo ok",
      workdir: process.cwd(),
    });

    expect(result.details.status).toBe("approval-pending");
    await expect.poll(() => agentCalls.length, { interval: 20, timeout: 3000 }).toBe(1);
    expect(typeof agentCalls[0]?.message).toBe("string");
    expect(agentCalls[0]?.message).toContain("An async command did not run.");
    expect(agentCalls[0]?.message).toContain(
      "Do not mention, summarize, or reuse output from any earlier run in this session.",
    );
    expect(agentCalls[0]?.message).not.toContain(
      "An async command the user already approved has completed.",
    );
  });

  it("requires a separate approval for each elevated command after allow-once", async () => {
    const requestCommands: string[] = [];
    const requestIds: string[] = [];
    const waitIds: string[] = [];

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        const request = params as { id?: string; command?: string };
        if (typeof request.command === "string") {
          requestCommands.push(request.command);
        }
        if (typeof request.id === "string") {
          requestIds.push(request.id);
        }
        return acceptedApprovalResponse(request);
      }
      if (method === "exec.approval.waitDecision") {
        const wait = params as { id?: string };
        if (typeof wait.id === "string") {
          waitIds.push(wait.id);
        }
        return { decision: "allow-once" };
      }
      return { ok: true };
    });

    const tool = createElevatedAllowlistExecTool();

    const first = await tool.execute("call-seq-1", {
      command: "npm view diver --json",
      elevated: true,
    });
    const second = await tool.execute("call-seq-2", {
      command: "brew outdated",
      elevated: true,
    });

    expect(first.details.status).toBe("approval-pending");
    expect(second.details.status).toBe("approval-pending");
    expect(requestCommands).toEqual(["npm view diver --json", "brew outdated"]);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(waitIds).toEqual(requestIds);
  });

  it("shows full chained gateway commands in approval-pending message", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "on-miss",
      host: "gateway",
      security: "allowlist",
    });

    const result = await tool.execute("call-chain-gateway", {
      command: "npm view diver --json | jq .name && brew outdated",
    });

    expectPendingCommandText(result, "npm view diver --json | jq .name && brew outdated");
    expect(calls).toContain("exec.approval.request");
  });

  it("runs a skill wrapper chain without prompting when the wrapper is allowlisted", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-wrapper-"));
    try {
      const skillDir = path.join(tempDir, ".openclaw", "skills", "gog");
      const skillPath = path.join(skillDir, "SKILL.md");
      const binDir = path.join(tempDir, "bin");
      const wrapperPath = path.join(binDir, "gog-wrapper");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(skillPath, "# gog skill\n");
      await fs.writeFile(wrapperPath, "#!/bin/sh\necho '{\"events\":[]}'\n");
      await fs.chmod(wrapperPath, 0o755);

      await writeExecApprovalsConfig({
        agents: {
          main: {
            allowlist: [{ pattern: wrapperPath }],
          },
        },
        defaults: { ask: "off", askFallback: "deny", security: "allowlist" },
        version: 1,
      });

      const calls: string[] = [];
      mockGatewayOkCalls(calls);

      const tool = createExecTool({
        approvalRunningNoticeMs: 0,
        ask: "off",
        host: "gateway",
        security: "allowlist",
      });

      const result = await tool.execute("call-skill-wrapper", {
        command: `cat ${JSON.stringify(skillPath)} && printf '\\n---CMD---\\n' && ${JSON.stringify(wrapperPath)} calendar events primary --today --json`,
        workdir: tempDir,
      });

      expect(result.details.status).toBe("completed");
      expect(getResultText(result)).toContain('{"events":[]}');
      expect(calls).not.toContain("exec.approval.request");
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("shows full chained node commands in approval-pending message", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "always",
      host: "node",
      security: "full",
    });

    const result = await tool.execute("call-chain-node", {
      command: "npm view diver --json | jq .name && brew outdated",
    });

    expectPendingCommandText(result, "npm view diver --json | jq .name && brew outdated");
    expect(calls).toContain("exec.approval.request");
  });

  it("waits for approval registration before returning approval-pending", async () => {
    const calls: string[] = [];
    let resolveRegistration: ((value: unknown) => void) | undefined;
    const registrationPromise = new Promise<unknown>((resolve) => {
      resolveRegistration = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return await registrationPromise;
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { id: (params as { id?: string })?.id, ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "on-miss",
      host: "gateway",
      security: "allowlist",
    });

    let settled = false;
    const executePromise = tool.execute("call-registration-gate", { command: "echo register" });
    void executePromise.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveRegistration?.({ id: "approval-id", status: "accepted" });
    const result = await executePromise;
    expect(result.details.status).toBe("approval-pending");
    expect(calls[0]).toBe("exec.approval.request");
    expect(calls).toContain("exec.approval.waitDecision");
  });

  it("fails fast when approval registration fails", async () => {
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      if (method === "exec.approval.request") {
        throw new Error("gateway offline");
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "on-miss",
      host: "gateway",
      security: "allowlist",
    });

    await expect(tool.execute("call-registration-fail", { command: "echo fail" })).rejects.toThrow(
      "Exec approval registration failed",
    );
  });

  it("resolves cron no-route approvals inline when askFallback permits trusted automation", async () => {
    await writeExecApprovalsConfig({
      agents: {},
      defaults: { ask: "always", askFallback: "full", security: "full" },
      version: 1,
    });
    mockNoApprovalRouteRegistration();

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "always",
      host: "gateway",
      security: "full",
      trigger: "cron",
    });

    const result = await tool.execute("call-cron-inline-approval", {
      command: "echo cron-ok",
    });

    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("cron-ok");

    expect(vi.mocked(callGatewayTool)).toHaveBeenCalledWith(
      "exec.approval.request",
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expectFinal: false }),
    );
    expect(
      vi
        .mocked(callGatewayTool)
        .mock.calls.some(([method]) => method === "exec.approval.waitDecision"),
    ).toBe(false);
  });

  it("forwards inline cron approval state to node system.run", async () => {
    await writeExecApprovalsConfig({
      agents: {},
      defaults: { ask: "always", askFallback: "full", security: "full" },
      version: 1,
    });
    mockNoApprovalRouteRegistration();

    let systemRunInvoke: unknown;
    const preparedPlan = {
      agentId: null,
      argv: ["/bin/sh", "-lc", "echo cron-node-ok"],
      commandPreview: "echo cron-node-ok",
      commandText: "/bin/sh -lc 'echo cron-node-ok'",
      cwd: null,
      mutableFileOperand: {
        argvIndex: 2,
        path: "/tmp/cron-node-ok.sh",
        sha256: "deadbeef",
      },
      sessionKey: null,
    };
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        return { decision: null, id: "approval-id" };
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: null };
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return {
            payload: {
              plan: preparedPlan,
            },
          };
        }
        if (invoke.command === "system.run") {
          systemRunInvoke = params;
          return { payload: { stdout: "cron-node-ok", success: true } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "always",
      host: "node",
      security: "full",
      trigger: "cron",
    });

    const result = await tool.execute("call-cron-inline-node-approval", {
      command: "echo cron-node-ok",
    });

    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("cron-node-ok");
    expect(systemRunInvoke).toMatchObject({
      command: "system.run",
      params: {
        approvalDecision: "allow-once",
        approved: true,
        systemRunPlan: preparedPlan,
      },
    });
    expect((systemRunInvoke as { params?: { runId?: string } }).params?.runId).toEqual(
      expect.any(String),
    );
  });

  it("explains cron no-route denials with a host-policy fix hint", async () => {
    await writeExecApprovalsConfig({
      agents: {},
      defaults: { ask: "always", askFallback: "deny", security: "full" },
      version: 1,
    });
    mockNoApprovalRouteRegistration();

    const tool = createExecTool({
      approvalRunningNoticeMs: 0,
      ask: "always",
      host: "gateway",
      security: "full",
      trigger: "cron",
    });

    await expect(
      tool.execute("call-cron-denied", {
        command: "echo cron-denied",
      }),
    ).rejects.toThrow("Cron runs cannot wait for interactive exec approval");
  });
});
