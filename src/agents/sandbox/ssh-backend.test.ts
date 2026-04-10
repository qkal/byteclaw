import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "../../../test/helpers/sandbox-fixtures.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SandboxConfig } from "./types.js";

const sshMocks = vi.hoisted(() => ({
  buildSshSandboxArgv: vi.fn(),
  createSshSandboxSessionFromSettings: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
  runSshSandboxCommand: vi.fn(),
  uploadDirectoryToSshTarget: vi.fn(),
}));

vi.mock("./ssh.js", async () => {
  const actual = await vi.importActual<typeof import("./ssh.js")>("./ssh.js");
  return {
    ...actual,
    buildSshSandboxArgv: sshMocks.buildSshSandboxArgv,
    createSshSandboxSessionFromSettings: sshMocks.createSshSandboxSessionFromSettings,
    disposeSshSandboxSession: sshMocks.disposeSshSandboxSession,
    runSshSandboxCommand: sshMocks.runSshSandboxCommand,
    uploadDirectoryToSshTarget: sshMocks.uploadDirectoryToSshTarget,
  };
});

const { createSshSandboxBackend, sshSandboxBackendManager } = await import("./ssh-backend.js");

function createConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          backend: "ssh",
          mode: "all",
          scope: "session",
          ssh: {
            command: "ssh",
            strictHostKeyChecking: true,
            target: "peter@example.com:2222",
            updateHostKeys: true,
            workspaceRoot: "/remote/openclaw",
          },
          workspaceAccess: "rw",
        },
      },
    },
  };
}

function createSession() {
  return {
    command: "ssh",
    configPath: path.join(os.tmpdir(), "openclaw-test-ssh-config"),
    host: "openclaw-sandbox",
  };
}

function createBackendSandboxConfig(params?: { binds?: string[]; target?: string }): SandboxConfig {
  return {
    backend: "ssh",
    browser: createSandboxBrowserConfig({
      autoStartTimeoutMs: 1,
      cdpPort: 1,
      containerPrefix: "prefix-",
      image: "img",
      noVncPort: 3,
      vncPort: 2,
    }),
    docker: {
      capDrop: ["ALL"],
      containerPrefix: "prefix-",
      env: {},
      image: "img",
      network: "none",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      workdir: "/workspace",
      ...(params?.binds ? { binds: params.binds } : {}),
    },
    mode: "all",
    prune: createSandboxPruneConfig(),
    scope: "session",
    ssh: {
      ...createSandboxSshConfig(
        "/remote/openclaw",
        params?.target ? { target: params.target } : {},
      ),
    },
    tools: { allow: [], deny: [] },
    workspaceAccess: "rw" as const,
    workspaceRoot: "~/.openclaw/sandboxes",
  };
}

async function expectBackendCreationToReject(params: {
  binds?: string[];
  target?: string;
  error: string;
}) {
  await expect(
    createSshSandboxBackend({
      agentWorkspaceDir: "/tmp/workspace",
      cfg: createBackendSandboxConfig({
        binds: params.binds,
        target: params.target,
      }),
      scopeKey: "s",
      sessionKey: "s",
      workspaceDir: "/tmp/workspace",
    }),
  ).rejects.toThrow(params.error);
}

describe("ssh sandbox backend", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    sshMocks.createSshSandboxSessionFromSettings.mockResolvedValue(createSession());
    sshMocks.disposeSshSandboxSession.mockResolvedValue(undefined);
    sshMocks.runSshSandboxCommand.mockResolvedValue({
      code: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from("1\n"),
    });
    sshMocks.uploadDirectoryToSshTarget.mockResolvedValue(undefined);
    sshMocks.buildSshSandboxArgv.mockImplementation(({ session, remoteCommand, tty }) => [
      session.command,
      "-F",
      session.configPath,
      tty ? "-tt" : "-T",
      session.host,
      remoteCommand,
    ]);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it("describes runtimes via the configured ssh target", async () => {
    const result = await sshSandboxBackendManager.describeRuntime({
      config: createConfig(),
      entry: {
        backendId: "ssh",
        configLabelKind: "Target",
        containerName: "openclaw-ssh-worker-abcd1234",
        createdAtMs: 1,
        image: "peter@example.com:2222",
        lastUsedAtMs: 1,
        runtimeLabel: "openclaw-ssh-worker-abcd1234",
        sessionKey: "agent:worker",
      },
    });

    expect(result).toEqual({
      actualConfigLabel: "peter@example.com:2222",
      configLabelMatch: true,
      running: true,
    });
    expect(sshMocks.createSshSandboxSessionFromSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "peter@example.com:2222",
        workspaceRoot: "/remote/openclaw",
      }),
    );
    expect(sshMocks.runSshSandboxCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteCommand: expect.stringContaining("/remote/openclaw/openclaw-ssh-agent-worker"),
      }),
    );
  });

  it("removes runtimes by deleting the remote scope root", async () => {
    await sshSandboxBackendManager.removeRuntime({
      config: createConfig(),
      entry: {
        backendId: "ssh",
        configLabelKind: "Target",
        containerName: "openclaw-ssh-worker-abcd1234",
        createdAtMs: 1,
        image: "peter@example.com:2222",
        lastUsedAtMs: 1,
        runtimeLabel: "openclaw-ssh-worker-abcd1234",
        sessionKey: "agent:worker",
      },
    });

    expect(sshMocks.runSshSandboxCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: true,
        remoteCommand: expect.stringContaining('rm -rf -- "$1"'),
      }),
    );
  });

  it("creates a remote-canonical backend that seeds once and reuses ssh exec", async () => {
    sshMocks.runSshSandboxCommand
      .mockResolvedValueOnce({
        code: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("0\n"),
      })
      .mockResolvedValueOnce({
        code: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      })
      .mockResolvedValueOnce({
        code: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      });

    const backend = await createSshSandboxBackend({
      agentWorkspaceDir: "/tmp/agent",
      cfg: {
        backend: "ssh",
        browser: {
          allowHostControl: false,
          autoStart: false,
          autoStartTimeoutMs: 1000,
          cdpPort: 9222,
          containerPrefix: "openclaw-browser-",
          enableNoVnc: false,
          enabled: false,
          headless: true,
          image: "openclaw-browser",
          network: "bridge",
          noVncPort: 6080,
          vncPort: 5900,
        },
        docker: {
          capDrop: ["ALL"],
          containerPrefix: "openclaw-sbx-",
          env: { LANG: "C.UTF-8" },
          image: "openclaw-sandbox:bookworm-slim",
          network: "none",
          readOnlyRoot: true,
          tmpfs: ["/tmp"],
          workdir: "/workspace",
        },
        mode: "all",
        prune: { idleHours: 24, maxAgeDays: 7 },
        scope: "session",
        ssh: {
          command: "ssh",
          strictHostKeyChecking: true,
          target: "peter@example.com:2222",
          updateHostKeys: true,
          workspaceRoot: "/remote/openclaw",
        },
        tools: { allow: [], deny: [] },
        workspaceAccess: "rw",
        workspaceRoot: "~/.openclaw/sandboxes",
      },
      scopeKey: "agent:worker",
      sessionKey: "agent:worker:task",
      workspaceDir: "/tmp/workspace",
    });

    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      env: { TEST_TOKEN: "1" },
      usePty: false,
    });

    expect(execSpec.argv).toEqual(
      expect.arrayContaining(["ssh", "-F", createSession().configPath, "-T", createSession().host]),
    );
    expect(execSpec.argv.at(-1)).toContain("/remote/openclaw/openclaw-ssh-agent-worker");
    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenCalledTimes(2);
    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        localDir: "/tmp/workspace",
        remoteDir: expect.stringContaining("/workspace"),
      }),
    );
    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        localDir: "/tmp/agent",
        remoteDir: expect.stringContaining("/agent"),
      }),
    );

    await backend.finalizeExec?.({
      exitCode: 0,
      status: "completed",
      timedOut: false,
      token: execSpec.finalizeToken,
    });
    expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalled();
  });

  it("filters blocked secrets from exec subprocess env", async () => {
    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.LANG = "en_US.UTF-8";
    const backend = await createSshSandboxBackend({
      agentWorkspaceDir: "/tmp/agent",
      cfg: createBackendSandboxConfig({
        target: "peter@example.com:2222",
      }),
      scopeKey: "agent:worker",
      sessionKey: "agent:worker:task",
      workspaceDir: "/tmp/workspace",
    });

    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      env: {},
      usePty: false,
    });

    expect(execSpec.env?.OPENAI_API_KEY).toBeUndefined();
    expect(execSpec.env?.LANG).toBe("en_US.UTF-8");
  });

  it("rejects docker binds and missing ssh target", async () => {
    await expectBackendCreationToReject({
      binds: ["/tmp:/tmp:rw"],
      error: "does not support sandbox.docker.binds",
      target: "peter@example.com:22",
    });

    await expectBackendCreationToReject({
      error: "requires agents.defaults.sandbox.ssh.target",
    });
  });
});
