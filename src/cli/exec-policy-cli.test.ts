import crypto from "node:crypto";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "../infra/exec-approvals.js";
import { stripAnsi } from "../terminal/ansi.js";
import { registerExecPolicyCli } from "./exec-policy-cli.js";

function hashApprovalsFile(file: ExecApprovalsFile): string {
  return crypto
    .createHash("sha256")
    .update(`${JSON.stringify(file, null, 2)}\n`)
    .digest("hex");
}

const mocks = vi.hoisted(() => {
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  let configState: OpenClawConfig = {
    tools: {
      exec: {
        ask: "on-miss",
        host: "auto",
        security: "allowlist",
      },
    },
  };
  let approvalsState: ExecApprovalsFile = {
    agents: {},
    defaults: {
      ask: "on-miss",
      askFallback: "deny",
      security: "allowlist",
    },
    version: 1,
  };
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
  };
  return {
    defaultRuntime,
    getApprovals: () => approvalsState,
    getConfig: () => configState,
    mutateConfigFile: vi.fn(async ({ mutate }: { mutate: (draft: OpenClawConfig) => void }) => {
      const draft = structuredClone(configState);
      mutate(draft);
      configState = draft;
      return {
        nextConfig: draft,
        path: "/tmp/openclaw.json",
        previousHash: "hash-1",
        result: undefined,
        snapshot: { path: "/tmp/openclaw.json" },
      };
    }),
    readConfigFileSnapshot: vi.fn<
      () => Promise<{ path: string; hash: string; config: OpenClawConfig }>
    >(async () => ({
      config: configState,
      hash: "config-hash-1",
      path: "/tmp/openclaw.json",
    })),
    readExecApprovalsSnapshot: vi.fn<() => ExecApprovalsSnapshot>(() => ({
      exists: true,
      file: approvalsState,
      hash: "approvals-hash",
      path: "/tmp/exec-approvals.json",
      raw: "{}",
    })),
    replaceConfigFile: vi.fn(
      async ({ nextConfig }: { nextConfig: OpenClawConfig; baseHash?: string }) => {
        configState = structuredClone(nextConfig);
        return {
          nextConfig,
          path: "/tmp/openclaw.json",
          previousHash: "hash-1",
          snapshot: { path: "/tmp/openclaw.json" },
        };
      },
    ),
    restoreExecApprovalsSnapshot: vi.fn(),
    runtimeErrors,
    saveExecApprovals: vi.fn((file: ExecApprovalsFile) => {
      approvalsState = file;
    }),
    setApprovals: (next: ExecApprovalsFile) => {
      approvalsState = next;
    },
    setConfig: (next: OpenClawConfig) => {
      configState = next;
    },
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshot: mocks.readExecApprovalsSnapshot,
    restoreExecApprovalsSnapshot: mocks.restoreExecApprovalsSnapshot,
    saveExecApprovals: mocks.saveExecApprovals,
  };
});

describe("exec-policy CLI", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerExecPolicyCli(program);
    return program;
  };

  const runExecPolicyCommand = async (args: string[]) => {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mocks.setConfig({
      tools: {
        exec: {
          ask: "on-miss",
          host: "auto",
          security: "allowlist",
        },
      },
    });
    mocks.setApprovals({
      agents: {},
      defaults: {
        ask: "on-miss",
        askFallback: "deny",
        security: "allowlist",
      },
      version: 1,
    });
    mocks.runtimeErrors.length = 0;
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.mutateConfigFile.mockReset();
    mocks.mutateConfigFile.mockImplementation(
      async ({ mutate }: { mutate: (draft: OpenClawConfig) => void }) => {
        const draft = structuredClone(mocks.getConfig());
        mutate(draft);
        mocks.setConfig(draft);
        return {
          nextConfig: draft,
          path: "/tmp/openclaw.json",
          previousHash: "hash-1",
          result: undefined,
          snapshot: { path: "/tmp/openclaw.json" },
        };
      },
    );
    mocks.replaceConfigFile.mockReset();
    mocks.replaceConfigFile.mockImplementation(
      async ({ nextConfig }: { nextConfig: OpenClawConfig; baseHash?: string }) => {
        mocks.setConfig(structuredClone(nextConfig));
        return {
          nextConfig,
          path: "/tmp/openclaw.json",
          previousHash: "hash-1",
          snapshot: { path: "/tmp/openclaw.json" },
        };
      },
    );
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockImplementation(async () => ({
      config: mocks.getConfig(),
      hash: "config-hash-1",
      path: "/tmp/openclaw.json",
    }));
    mocks.readExecApprovalsSnapshot.mockReset();
    mocks.readExecApprovalsSnapshot.mockImplementation(() => ({
      exists: true,
      file: mocks.getApprovals(),
      hash: "approvals-hash",
      path: "/tmp/exec-approvals.json",
      raw: "{}",
    }));
    mocks.restoreExecApprovalsSnapshot.mockReset();
    mocks.restoreExecApprovalsSnapshot.mockImplementation((_snapshot: ExecApprovalsSnapshot) => {});
    mocks.saveExecApprovals.mockReset();
    mocks.saveExecApprovals.mockImplementation((file: ExecApprovalsFile) => {
      mocks.setApprovals(file);
    });
  });

  it("shows the local merged exec policy as json", async () => {
    await runExecPolicyCommand(["exec-policy", "show", "--json"]);

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalsPath: "/tmp/exec-approvals.json",
        configPath: "/tmp/openclaw.json",
        effectivePolicy: expect.objectContaining({
          scopes: [
            expect.objectContaining({
              ask: expect.objectContaining({
                requested: "on-miss",
                host: "on-miss",
                effective: "on-miss",
              }),
              scopeLabel: "tools.exec",
              security: expect.objectContaining({
                requested: "allowlist",
                host: "allowlist",
                effective: "allowlist",
              }),
            }),
          ],
        }),
      }),
      0,
    );
  });

  it("marks host=node scopes as node-managed in show output", async () => {
    mocks.setConfig({
      tools: {
        exec: {
          ask: "on-miss",
          host: "node",
          security: "allowlist",
        },
      },
    });

    await runExecPolicyCommand(["exec-policy", "show", "--json"]);

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        effectivePolicy: expect.objectContaining({
          note: expect.stringContaining("host=node"),
          scopes: [
            expect.objectContaining({
              ask: expect.objectContaining({
                effective: "unknown",
                host: "unknown",
                hostSource: "node runtime approvals",
                requested: "on-miss",
              }),
              askFallback: expect.objectContaining({
                effective: "unknown",
                source: "node runtime approvals",
              }),
              runtimeApprovalsSource: "node-runtime",
              scopeLabel: "tools.exec",
              security: expect.objectContaining({
                effective: "unknown",
                host: "unknown",
                hostSource: "node runtime approvals",
                requested: "allowlist",
              }),
            }),
          ],
        }),
      }),
      0,
    );
    const [{ effectivePolicy }] = mocks.defaultRuntime.writeJson.mock.calls.at(-1) as [
      Record<string, unknown>,
      number,
    ];
    expect((effectivePolicy as { scopes: Record<string, unknown>[] }).scopes[0]).not.toHaveProperty(
      "allowedDecisions",
    );
  });

  it("applies the yolo preset to both config and approvals", async () => {
    await runExecPolicyCommand(["exec-policy", "preset", "yolo", "--json"]);

    expect(mocks.getConfig().tools?.exec).toEqual({
      ask: "off",
      host: "gateway",
      security: "full",
    });
    expect(mocks.getApprovals().defaults).toEqual({
      ask: "off",
      askFallback: "full",
      security: "full",
    });
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        baseHash: "config-hash-1",
      }),
    );
    expect(mocks.saveExecApprovals).toHaveBeenCalledTimes(1);
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
  });

  it("sets explicit values without requiring a preset", async () => {
    await runExecPolicyCommand([
      "exec-policy",
      "set",
      "--host",
      "gateway",
      "--security",
      "full",
      "--ask",
      "off",
      "--ask-fallback",
      "allowlist",
      "--json",
    ]);

    expect(mocks.getConfig().tools?.exec).toEqual({
      ask: "off",
      host: "gateway",
      security: "full",
    });
    expect(mocks.getApprovals().defaults).toEqual({
      ask: "off",
      askFallback: "allowlist",
      security: "full",
    });
  });

  it("sanitizes terminal control content before rendering the text table", async () => {
    mocks.setConfig({
      tools: {
        exec: {
          ask: "on-miss",
          host: "auto",
          security: "allowlist\u001B[31m" as unknown as "allowlist",
        },
      },
    });
    mocks.readConfigFileSnapshot.mockImplementationOnce(async () => ({
      config: mocks.getConfig(),
      hash: "config-hash-1",
      path: "/tmp/openclaw.json\u001B[2J\nforged",
    }));
    mocks.readExecApprovalsSnapshot.mockImplementationOnce(() => ({
      exists: true,
      file: {
        agents: {
          "scope\u200Bname": {
            ask: "on-miss",
            askFallback: "deny",
            security: "allowlist",
          },
        },
        defaults: {
          ask: "off",
          askFallback: "full",
          security: "full",
        },
        version: 1,
      },
      hash: "approvals-hash",
      path: "/tmp/exec-approvals.json\u0007\nforged",
      raw: "{}",
    }));

    await runExecPolicyCommand(["exec-policy", "show"]);

    const output = stripAnsi(
      mocks.defaultRuntime.log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"),
    );
    expect(output).toContain("/tmp/openclaw.json");
    expect(output).toContain("/tmp/exec-approvals.json");
    expect(output).toContain(String.raw`scope\u{200B}name`);
    expect(output).toContain("host=auto");
    expect(output).toContain("tools.exec.");
    expect(output).toContain("host)");
    expect(output).toContain(String.raw`\nforged`);
    expect(output).not.toContain("/tmp/openclaw.json\nforged");
    expect(output).not.toContain("\u001B[2J");
    expect(output).not.toContain("\u0007");
  });

  it("reports invalid input once and exits once", async () => {
    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "nope"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.defaultRuntime.error).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeErrors).toEqual(["Invalid exec security: nope"]);
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledTimes(1);
  });

  it("rejects host=node for the local-only sync path", async () => {
    await expect(runExecPolicyCommand(["exec-policy", "set", "--host", "node"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(mocks.runtimeErrors).toEqual([
      "Local exec-policy cannot synchronize host=node. Node approvals are fetched from the node at runtime.",
    ]);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.saveExecApprovals).not.toHaveBeenCalled();
  });

  it("rejects sync when the resulting requested host remains node", async () => {
    mocks.setConfig({
      tools: {
        exec: {
          ask: "on-miss",
          host: "node",
          security: "allowlist",
        },
      },
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.runtimeErrors).toEqual([
      "Local exec-policy cannot synchronize host=node. Node approvals are fetched from the node at runtime.",
    ]);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.saveExecApprovals).not.toHaveBeenCalled();
  });

  it("rolls back approvals if the config write fails after approvals save", async () => {
    const originalApprovals = structuredClone(mocks.getApprovals());
    const originalRaw = JSON.stringify(originalApprovals, null, 2);
    const originalSnapshot: ExecApprovalsSnapshot = {
      exists: true,
      file: originalApprovals,
      hash: "approvals-hash",
      path: "/tmp/exec-approvals.json",
      raw: originalRaw,
    };
    mocks.readExecApprovalsSnapshot
      .mockImplementationOnce(() => originalSnapshot)
      .mockImplementationOnce(
        (): ExecApprovalsSnapshot => ({
          exists: true,
          file: structuredClone(mocks.getApprovals()),
          hash: hashApprovalsFile(mocks.getApprovals()),
          path: "/tmp/exec-approvals.json",
          raw: JSON.stringify(mocks.getApprovals(), null, 2),
        }),
      );
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      throw new Error("config write failed");
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.saveExecApprovals).toHaveBeenCalledTimes(1);
    expect(mocks.restoreExecApprovalsSnapshot).toHaveBeenCalledWith(originalSnapshot);
    expect(mocks.runtimeErrors).toEqual(["config write failed"]);
  });

  it("removes a newly-written approvals file when config replacement fails and the original file was missing", async () => {
    const missingSnapshot: ExecApprovalsSnapshot = {
      exists: false,
      file: { agents: {}, version: 1 },
      hash: "approvals-hash",
      path: "/tmp/missing-exec-approvals.json",
      raw: null,
    };
    mocks.readExecApprovalsSnapshot
      .mockImplementationOnce(() => missingSnapshot)
      .mockImplementationOnce(
        (): ExecApprovalsSnapshot => ({
          exists: true,
          file: structuredClone(mocks.getApprovals()),
          hash: hashApprovalsFile(mocks.getApprovals()),
          path: "/tmp/missing-exec-approvals.json",
          raw: JSON.stringify(mocks.getApprovals(), null, 2),
        }),
      );
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      throw new Error("config write failed");
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.restoreExecApprovalsSnapshot).toHaveBeenCalledWith(missingSnapshot);
  });

  it("does not clobber a newer approvals write during rollback", async () => {
    const originalApprovals = structuredClone(mocks.getApprovals());
    const originalRaw = JSON.stringify(originalApprovals, null, 2);
    const originalSnapshot = {
      exists: true,
      file: originalApprovals,
      hash: "original-hash",
      path: "/tmp/exec-approvals.json",
      raw: originalRaw,
    };
    const concurrentFile: ExecApprovalsFile = {
      agents: {},
      defaults: {
        ask: "off",
        askFallback: "deny",
        security: "deny",
      },
      version: 1,
    };
    const concurrentSnapshot: ExecApprovalsSnapshot = {
      exists: true,
      file: concurrentFile,
      hash: "concurrent-write-hash",
      path: "/tmp/exec-approvals.json",
      raw: JSON.stringify(concurrentFile, null, 2),
    };
    let snapshotReadCount = 0;
    mocks.readExecApprovalsSnapshot.mockImplementation(() => {
      snapshotReadCount += 1;
      return snapshotReadCount === 1 ? originalSnapshot : concurrentSnapshot;
    });
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      throw new Error("config write failed");
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.restoreExecApprovalsSnapshot).not.toHaveBeenCalled();
    expect(mocks.saveExecApprovals).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeErrors).toEqual(["config write failed"]);
  });
});
