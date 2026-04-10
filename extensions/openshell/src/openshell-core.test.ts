import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxTestContext } from "../../../src/agents/sandbox/test-fixtures.js";
import type { OpenShellSandboxBackend } from "./backend.js";
import {
  buildExecRemoteCommand,
  buildOpenShellBaseArgv,
  resolveOpenShellCommand,
  setBundledOpenShellCommandResolverForTest,
  shellEscape,
} from "./cli.js";
import { resolveOpenShellPluginConfig } from "./config.js";

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
}));

let createOpenShellSandboxBackendManager: typeof import("./backend.js").createOpenShellSandboxBackendManager;

describe("openshell cli helpers", () => {
  afterEach(() => {
    setBundledOpenShellCommandResolverForTest();
  });

  it("builds base argv with gateway overrides", () => {
    const config = resolveOpenShellPluginConfig({
      command: "/usr/local/bin/openshell",
      gateway: "lab",
      gatewayEndpoint: "https://lab.example",
    });
    expect(buildOpenShellBaseArgv(config)).toEqual([
      "/usr/local/bin/openshell",
      "--gateway",
      "lab",
      "--gateway-endpoint",
      "https://lab.example",
    ]);
  });

  it("prefers the bundled openshell command when available", () => {
    setBundledOpenShellCommandResolverForTest(() => "/tmp/node_modules/.bin/openshell");
    const config = resolveOpenShellPluginConfig(undefined);

    expect(resolveOpenShellCommand("openshell")).toBe("/tmp/node_modules/.bin/openshell");
    expect(buildOpenShellBaseArgv(config)).toEqual(["/tmp/node_modules/.bin/openshell"]);
  });

  it("falls back to the PATH command when no bundled openshell is present", () => {
    setBundledOpenShellCommandResolverForTest(() => null);

    expect(resolveOpenShellCommand("openshell")).toBe("openshell");
  });

  it("shell escapes single quotes", () => {
    expect(shellEscape(`a'b`)).toBe(`'a'"'"'b'`);
  });

  it("wraps exec commands with env and workdir", () => {
    const command = buildExecRemoteCommand({
      command: "pwd && printenv TOKEN",
      env: {
        TOKEN: "abc 123",
      },
      workdir: "/sandbox/project",
    });
    expect(command).toContain(`'env'`);
    expect(command).toContain(`'TOKEN=abc 123'`);
    expect(command).toContain(`'cd '"'"'/sandbox/project'"'"' && pwd && printenv TOKEN'`);
  });
});

describe("openshell backend manager", () => {
  beforeAll(async () => {
    vi.doMock("./cli.js", async () => {
      const actual = await vi.importActual<typeof import("./cli.js")>("./cli.js");
      return {
        ...actual,
        runOpenShellCli: cliMocks.runOpenShellCli,
      };
    });
    ({ createOpenShellSandboxBackendManager } = await import("./backend.js"));
  });

  afterAll(() => {
    vi.doUnmock("./cli.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checks runtime status with config override from OpenClaw config", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "{}",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        from: "openclaw",
      }),
    });

    const result = await manager.describeRuntime({
      config: {
        plugins: {
          entries: {
            openshell: {
              config: {
                command: "openshell",
                from: "custom-source",
              },
              enabled: true,
            },
          },
        },
      },
      entry: {
        backendId: "openshell",
        configLabelKind: "Source",
        containerName: "openclaw-session-1234",
        createdAtMs: 1,
        image: "custom-source",
        lastUsedAtMs: 1,
        runtimeLabel: "openclaw-session-1234",
        sessionKey: "agent:main",
      },
    });

    expect(result).toEqual({
      actualConfigLabel: "custom-source",
      configLabelMatch: true,
      running: true,
    });
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      args: ["sandbox", "get", "openclaw-session-1234"],
      context: expect.objectContaining({
        config: expect.objectContaining({
          from: "custom-source",
        }),
        sandboxName: "openclaw-session-1234",
      }),
    });
  });

  it("removes runtimes via openshell sandbox delete", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "/usr/local/bin/openshell",
        gateway: "lab",
      }),
    });

    await manager.removeRuntime({
      config: {},
      entry: {
        backendId: "openshell",
        configLabelKind: "Source",
        containerName: "openclaw-session-5678",
        createdAtMs: 1,
        image: "openclaw",
        lastUsedAtMs: 1,
        runtimeLabel: "openclaw-session-5678",
        sessionKey: "agent:main",
      },
    });

    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      args: ["sandbox", "delete", "openclaw-session-5678"],
      context: expect.objectContaining({
        config: expect.objectContaining({
          command: "/usr/local/bin/openshell",
          gateway: "lab",
        }),
        sandboxName: "openclaw-session-5678",
      }),
    });
  });
});

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

function createMirrorBackendMock(): OpenShellSandboxBackend {
  return {
    buildExecSpec: vi.fn(),
    env: {},
    id: "openshell",
    remoteAgentWorkspaceDir: "/agent",
    remoteWorkspaceDir: "/sandbox",
    runRemoteShellScript: vi.fn().mockResolvedValue({
      code: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    }),
    runShellCommand: vi.fn(),
    runtimeId: "openshell-test",
    runtimeLabel: "openshell-test",
    syncLocalPathToRemote: vi.fn().mockResolvedValue(undefined),
    workdir: "/sandbox",
  } as unknown as OpenShellSandboxBackend;
}

describe("openshell fs bridges", () => {
  it("writes locally and syncs the file to the remote workspace", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        agentWorkspaceDir: workspaceDir,
        backendId: "openshell",
        containerWorkdir: "/sandbox",
        workspaceDir,
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ backend, sandbox });
    await bridge.writeFile({
      data: "hello",
      filePath: "nested/file.txt",
      mkdir: true,
    });

    expect(await fs.readFile(path.join(workspaceDir, "nested", "file.txt"), "utf8")).toBe("hello");
    expect(backend.syncLocalPathToRemote).toHaveBeenCalledWith(
      path.join(workspaceDir, "nested", "file.txt"),
      "/sandbox/nested/file.txt",
    );
  });

  it("maps agent mount paths when the sandbox workspace is read-only", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const agentWorkspaceDir = await makeTempDir("openclaw-openshell-agent-");
    await fs.writeFile(path.join(agentWorkspaceDir, "note.txt"), "agent", "utf8");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        agentWorkspaceDir,
        backendId: "openshell",
        containerWorkdir: "/sandbox",
        workspaceAccess: "ro",
        workspaceDir,
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ backend, sandbox });
    const resolved = bridge.resolvePath({ filePath: "/agent/note.txt" });
    expect(resolved.hostPath).toBe(path.join(agentWorkspaceDir, "note.txt"));
    expect(await bridge.readFile({ filePath: "/agent/note.txt" })).toEqual(Buffer.from("agent"));
  });
});
