import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";
import { registerExecApprovalsCli } from "./exec-approvals-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const readBestEffortConfig = vi.fn(async () => ({}));
  const defaultRuntime = {
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
    log: vi.fn(),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
  };
  return {
    callGatewayFromCli: vi.fn(async (method: string, _opts: unknown, params?: unknown) => {
      if (method.endsWith(".get")) {
        if (method === "config.get") {
          return {
            config: {
              tools: {
                exec: {
                  ask: "off",
                  security: "full",
                },
              },
            },
          };
        }
        return {
          exists: true,
          file: { agents: {}, version: 1 },
          hash: "hash-1",
          path: "/tmp/exec-approvals.json",
        };
      }
      return { method, params };
    }),
    defaultRuntime,
    readBestEffortConfig,
    runtimeErrors,
  };
});

const { callGatewayFromCli, defaultRuntime, readBestEffortConfig, runtimeErrors } = mocks;

const localSnapshot = {
  exists: true,
  file: { agents: {}, version: 1 } as ExecApprovalsFile,
  hash: "hash-local",
  path: "/tmp/local-exec-approvals.json",
  raw: "{}",
};

function resetLocalSnapshot() {
  localSnapshot.file = { agents: {}, version: 1 };
}

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown) =>
    mocks.callGatewayFromCli(method, opts, params),
}));

vi.mock("./nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./nodes-cli/rpc.js")>("./nodes-cli/rpc.js");
  return {
    ...actual,
    resolveNodeId: vi.fn(async () => "node-1"),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    readBestEffortConfig: mocks.readBestEffortConfig,
  };
});

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshot: () => localSnapshot,
    saveExecApprovals: vi.fn(),
  };
});

describe("exec approvals CLI", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);
    return program;
  };

  const runApprovalsCommand = async (args: string[]) => {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
  };

  beforeEach(() => {
    resetLocalSnapshot();
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();
    readBestEffortConfig.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("routes get command to local, gateway, and node modes", async () => {
    await runApprovalsCommand(["approvals", "get"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(readBestEffortConfig).toHaveBeenCalledTimes(1);
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    await runApprovalsCommand(["approvals", "get", "--gateway"]);

    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      1,
      "exec.approvals.get",
      expect.anything(),
      {},
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(2, "config.get", expect.anything(), {});
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    await runApprovalsCommand(["approvals", "get", "--node", "macbook"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.node.get", expect.anything(), {
      nodeId: "node-1",
    });
    expect(callGatewayFromCli).toHaveBeenCalledWith("config.get", expect.anything(), {});
    expect(runtimeErrors).toHaveLength(0);
  });

  it("adds effective policy to json output", async () => {
    localSnapshot.file = {
      agents: {},
      defaults: { ask: "always", askFallback: "deny", security: "allowlist" },
      version: 1,
    };
    readBestEffortConfig.mockResolvedValue({
      tools: {
        exec: {
          ask: "off",
          security: "full",
        },
      },
    });

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        effectivePolicy: {
          note: "Effective exec policy is the host approvals file intersected with requested tools.exec policy.",
          scopes: [
            expect.objectContaining({
              ask: expect.objectContaining({
                effective: "always",
                host: "always",
                requested: "off",
              }),
              scopeLabel: "tools.exec",
              security: expect.objectContaining({
                effective: "allowlist",
                host: "allowlist",
                requested: "full",
              }),
            }),
          ],
        },
      }),
      0,
    );
  });

  it("reports wildcard host policy sources in effective policy output", async () => {
    localSnapshot.file = {
      agents: {
        "*": {
          ask: "always",
          askFallback: "deny",
          security: "allowlist",
        },
      },
      defaults: { ask: "off", askFallback: "full", security: "full" },
      version: 1,
    };
    readBestEffortConfig.mockResolvedValue({
      agents: {
        list: [
          {
            id: "runner",
            tools: {
              exec: {
                ask: "off",
                security: "full",
              },
            },
          },
        ],
      },
    });

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        effectivePolicy: expect.objectContaining({
          scopes: expect.arrayContaining([
            expect.objectContaining({
              ask: expect.objectContaining({
                hostSource: "/tmp/local-exec-approvals.json agents.*.ask",
              }),
              askFallback: expect.objectContaining({
                source: "/tmp/local-exec-approvals.json agents.*.askFallback",
              }),
              scopeLabel: "agent:runner",
              security: expect.objectContaining({
                hostSource: "/tmp/local-exec-approvals.json agents.*.security",
              }),
            }),
          ]),
        }),
      }),
      0,
    );
  });

  it("adds combined node effective policy to json output", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          return {
            config: {
              tools: {
                exec: {
                  ask: "off",
                  security: "full",
                },
              },
            },
          };
        }
        if (method === "exec.approvals.node.get") {
          return {
            exists: true,
            file: {
              agents: {},
              defaults: { ask: "always", askFallback: "deny", security: "allowlist" },
              version: 1,
            },
            hash: "hash-node-1",
            path: "/tmp/node-exec-approvals.json",
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--node", "macbook", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        effectivePolicy: {
          note: "Effective exec policy is the node host approvals file intersected with gateway tools.exec policy.",
          scopes: [
            expect.objectContaining({
              ask: expect.objectContaining({
                effective: "always",
                host: "always",
                requested: "off",
              }),
              askFallback: expect.objectContaining({
                effective: "deny",
                source: "/tmp/node-exec-approvals.json defaults.askFallback",
              }),
              scopeLabel: "tools.exec",
              security: expect.objectContaining({
                effective: "allowlist",
                host: "allowlist",
                requested: "full",
              }),
            }),
          ],
        },
      }),
      0,
    );
  });

  it("keeps gateway approvals output when config.get fails", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          throw new Error("gateway config unavailable");
        }
        if (method === "exec.approvals.get") {
          return {
            exists: true,
            file: { agents: {}, version: 1 },
            hash: "hash-1",
            path: "/tmp/exec-approvals.json",
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--gateway", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        effectivePolicy: {
          note: "Config unavailable.",
          scopes: [],
        },
      }),
      0,
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it("keeps node approvals output when gateway config is unavailable", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          throw new Error("gateway config unavailable");
        }
        if (method === "exec.approvals.node.get") {
          return {
            exists: true,
            file: { agents: {}, version: 1 },
            hash: "hash-node-1",
            path: "/tmp/node-exec-approvals.json",
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--node", "macbook", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        effectivePolicy: {
          note: "Gateway config unavailable. Node output above shows host approvals state only, and final runtime policy still intersects with gateway tools.exec.",
          scopes: [],
        },
      }),
      0,
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it("keeps local approvals output when config load fails", async () => {
    readBestEffortConfig.mockRejectedValue(new Error("duplicate agent directories"));

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        effectivePolicy: {
          note: "Config unavailable.",
          scopes: [],
        },
      }),
      0,
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it("reports agent scopes with inherited global requested policy", async () => {
    localSnapshot.file = {
      agents: {
        runner: {
          ask: "always",
          security: "allowlist",
        },
      },
      version: 1,
    };
    readBestEffortConfig.mockResolvedValue({
      agents: {
        list: [{ id: "runner" }],
      },
      tools: {
        exec: {
          ask: "off",
          security: "full",
        },
      },
    });

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(expect.anything(), 0);

    const output = vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0] as {
      effectivePolicy: { scopes: unknown[] };
    };

    expect(output.effectivePolicy.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ask: expect.objectContaining({
            effective: "off",
            requested: "off",
            requestedSource: "tools.exec.ask",
          }),
          askFallback: expect.objectContaining({
            effective: "full",
            source: "OpenClaw default (full)",
          }),
          scopeLabel: "tools.exec",
          security: expect.objectContaining({
            effective: "full",
            requested: "full",
            requestedSource: "tools.exec.security",
          }),
        }),
        expect.objectContaining({
          ask: expect.objectContaining({
            effective: "always",
            requested: "off",
            requestedSource: "tools.exec.ask",
          }),
          askFallback: expect.objectContaining({
            effective: "allowlist",
            source: "OpenClaw default (full)",
          }),
          scopeLabel: "agent:runner",
          security: expect.objectContaining({
            effective: "allowlist",
            requested: "full",
            requestedSource: "tools.exec.security",
          }),
        }),
      ]),
    );
  });

  it("defaults allowlist add to wildcard agent", async () => {
    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "add", "/usr/bin/uname"]);

    expect(callGatewayFromCli).not.toHaveBeenCalledWith(
      "exec.approvals.set",
      expect.anything(),
      {},
    );
    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          "*": expect.anything(),
        }),
      }),
    );
  });

  it("removes wildcard allowlist entry and prunes empty agent", async () => {
    localSnapshot.file = {
      agents: {
        "*": {
          allowlist: [{ lastUsedAt: Date.now(), pattern: "/usr/bin/uname" }],
        },
      },
      version: 1,
    };

    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "remove", "/usr/bin/uname"]);

    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: undefined,
        version: 1,
      }),
    );
    expect(runtimeErrors).toHaveLength(0);
  });
});
