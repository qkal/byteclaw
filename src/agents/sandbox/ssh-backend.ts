import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  type RemoteShellSandboxHandle,
  createRemoteShellSandboxFsBridge,
} from "./remote-fs-bridge.js";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";
import {
  type SshSandboxSession,
  buildExecRemoteCommand,
  buildRemoteCommand,
  buildSshSandboxArgv,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  runSshSandboxCommand,
  uploadDirectoryToSshTarget,
} from "./ssh.js";

interface PendingExec {
  sshSession: SshSandboxSession;
}

interface ResolvedSshRuntimePaths {
  runtimeId: string;
  runtimeRootDir: string;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
}

export const sshSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime({ entry, config, agentId }) {
    const cfg = resolveSandboxConfigForAgent(config, agentId);
    if (cfg.backend !== "ssh" || !cfg.ssh.target) {
      return {
        actualConfigLabel: cfg.ssh.target,
        configLabelMatch: false,
        running: false,
      };
    }
    const runtimePaths = resolveSshRuntimePaths(cfg.ssh.workspaceRoot, entry.sessionKey);
    const session = await createSshSandboxSessionFromSettings({
      ...cfg.ssh,
      target: cfg.ssh.target,
    });
    try {
      const result = await runSshSandboxCommand({
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          String.raw`if [ -d "$1" ]; then printf "1\n"; else printf "0\n"; fi`,
          "openclaw-sandbox-check",
          runtimePaths.runtimeRootDir,
        ]),
        session,
      });
      return {
        actualConfigLabel: cfg.ssh.target,
        configLabelMatch: entry.image === cfg.ssh.target,
        running: result.stdout.toString("utf8").trim() === "1",
      };
    } finally {
      await disposeSshSandboxSession(session);
    }
  },
  async removeRuntime({ entry, config, agentId }) {
    const cfg = resolveSandboxConfigForAgent(config, agentId);
    if (cfg.backend !== "ssh" || !cfg.ssh.target) {
      return;
    }
    const runtimePaths = resolveSshRuntimePaths(cfg.ssh.workspaceRoot, entry.sessionKey);
    const session = await createSshSandboxSessionFromSettings({
      ...cfg.ssh,
      target: cfg.ssh.target,
    });
    try {
      await runSshSandboxCommand({
        allowFailure: true,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          'rm -rf -- "$1"',
          "openclaw-sandbox-remove",
          runtimePaths.runtimeRootDir,
        ]),
        session,
      });
    } finally {
      await disposeSshSandboxSession(session);
    }
  },
};

export async function createSshSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  if ((params.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("SSH sandbox backend does not support sandbox.docker.binds.");
  }
  const {target} = params.cfg.ssh;
  if (!target) {
    throw new Error('Sandbox backend "ssh" requires agents.defaults.sandbox.ssh.target.');
  }

  const runtimePaths = resolveSshRuntimePaths(params.cfg.ssh.workspaceRoot, params.scopeKey);
  const impl = new SshSandboxBackendImpl({
    createParams: params,
    runtimePaths,
    target,
  });
  return impl.asHandle();
}

class SshSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;

  constructor(
    private readonly params: {
      createParams: CreateSandboxBackendParams;
      target: string;
      runtimePaths: ResolvedSshRuntimePaths;
    },
  ) {}

  asHandle(): SandboxBackendHandle & RemoteShellSandboxHandle {
    return {
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        await this.ensureRuntime();
        const sshSession = await this.createSession();
        const remoteCommand = buildExecRemoteCommand({
          command,
          env,
          workdir: workdir ?? this.params.runtimePaths.remoteWorkspaceDir,
        });
        return {
          argv: buildSshSandboxArgv({
            session: sshSession,
            remoteCommand,
            tty: usePty,
          }),
          env: sanitizeEnvVars(process.env).allowed,
          finalizeToken: { sshSession } satisfies PendingExec,
          stdinMode: "pipe-open",
        };
      },
      configLabel: this.params.target,
      configLabelKind: "Target",
      createFsBridge: ({ sandbox }) =>
        createRemoteShellSandboxFsBridge({
          runtime: this.asHandle(),
          sandbox,
        }),
      env: this.params.createParams.cfg.docker.env,
      finalizeExec: async ({ token }) => {
        const sshSession = (token as PendingExec | undefined)?.sshSession;
        if (sshSession) {
          await disposeSshSandboxSession(sshSession);
        }
      },
      id: "ssh",
      remoteAgentWorkspaceDir: this.params.runtimePaths.remoteAgentWorkspaceDir,
      remoteWorkspaceDir: this.params.runtimePaths.remoteWorkspaceDir,
      runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
      runShellCommand: async (command) => await this.runRemoteShellScript(command),
      runtimeId: this.params.runtimePaths.runtimeId,
      runtimeLabel: this.params.runtimePaths.runtimeId,
      workdir: this.params.runtimePaths.remoteWorkspaceDir,
    };
  }

  private async createSession(): Promise<SshSandboxSession> {
    return await createSshSandboxSessionFromSettings({
      ...this.params.createParams.cfg.ssh,
      target: this.params.target,
    });
  }

  private async ensureRuntime(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    this.ensurePromise = this.ensureRuntimeInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureRuntimeInner(): Promise<void> {
    const session = await this.createSession();
    try {
      const exists = await runSshSandboxCommand({
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          String.raw`if [ -d "$1" ]; then printf "1\n"; else printf "0\n"; fi`,
          "openclaw-sandbox-check",
          this.params.runtimePaths.runtimeRootDir,
        ]),
        session,
      });
      if (exists.stdout.toString("utf8").trim() === "1") {
        return;
      }
      await this.replaceRemoteDirectoryFromLocal(
        session,
        this.params.createParams.workspaceDir,
        this.params.runtimePaths.remoteWorkspaceDir,
      );
      if (
        this.params.createParams.cfg.workspaceAccess !== "none" &&
        path.resolve(this.params.createParams.agentWorkspaceDir) !==
          path.resolve(this.params.createParams.workspaceDir)
      ) {
        await this.replaceRemoteDirectoryFromLocal(
          session,
          this.params.createParams.agentWorkspaceDir,
          this.params.runtimePaths.remoteAgentWorkspaceDir,
        );
      }
    } finally {
      await disposeSshSandboxSession(session);
    }
  }

  private async replaceRemoteDirectoryFromLocal(
    session: SshSandboxSession,
    localDir: string,
    remoteDir: string,
  ): Promise<void> {
    await runSshSandboxCommand({
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        'mkdir -p -- "$1" && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
        "openclaw-sandbox-clear",
        remoteDir,
      ]),
      session,
    });
    await uploadDirectoryToSshTarget({
      localDir,
      remoteDir,
      session,
    });
  }

  async runRemoteShellScript(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    await this.ensureRuntime();
    const session = await this.createSession();
    try {
      return await runSshSandboxCommand({
        allowFailure: params.allowFailure,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          params.script,
          "openclaw-sandbox-fs",
          ...(params.args ?? []),
        ]),
        session,
        signal: params.signal,
        stdin: params.stdin,
      });
    } finally {
      await disposeSshSandboxSession(session);
    }
  }
}

function resolveSshRuntimePaths(workspaceRoot: string, scopeKey: string): ResolvedSshRuntimePaths {
  const runtimeId = buildSshSandboxRuntimeId(scopeKey);
  const runtimeRootDir = path.posix.join(workspaceRoot, runtimeId);
  return {
    remoteAgentWorkspaceDir: path.posix.join(runtimeRootDir, "agent"),
    remoteWorkspaceDir: path.posix.join(runtimeRootDir, "workspace"),
    runtimeId,
    runtimeRootDir,
  };
}

function buildSshSandboxRuntimeId(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = [...trimmed].reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `openclaw-ssh-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
