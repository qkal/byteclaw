import fs from "node:fs/promises";
import path from "node:path";
import type {
  CreateSandboxBackendParams,
  OpenClawConfig,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendManager,
  SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import {
  createRemoteShellSandboxFsBridge,
  disposeSshSandboxSession,
  resolvePreferredOpenClawTmpDir,
  runSshSandboxCommand,
  sanitizeEnvVars,
} from "openclaw/plugin-sdk/sandbox";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { OpenShellSandboxBackend } from "./backend.types.js";
import {
  type OpenShellExecContext,
  buildExecRemoteCommand,
  buildRemoteCommand,
  createOpenShellSshSession,
  runOpenShellCli,
} from "./cli.js";
import { type ResolvedOpenShellPluginConfig, resolveOpenShellPluginConfig } from "./config.js";
import { createOpenShellFsBridge } from "./fs-bridge.js";
import {
  DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
  replaceDirectoryContents,
  stageDirectoryContents,
} from "./mirror.js";

interface CreateOpenShellSandboxBackendFactoryParams {
  pluginConfig: ResolvedOpenShellPluginConfig;
}

interface PendingExec {
  sshSession: SshSandboxSession;
}

export function buildOpenShellSshExecEnv(): NodeJS.ProcessEnv {
  return sanitizeEnvVars(process.env).allowed;
}

export type { OpenShellFsBridgeContext, OpenShellSandboxBackend } from "./backend.types.js";

export function createOpenShellSandboxBackendFactory(
  params: CreateOpenShellSandboxBackendFactoryParams,
): SandboxBackendFactory {
  return async (createParams) =>
    await createOpenShellSandboxBackend({
      ...params,
      createParams,
    });
}

export function createOpenShellSandboxBackendManager(params: {
  pluginConfig: ResolvedOpenShellPluginConfig;
}): SandboxBackendManager {
  return {
    async describeRuntime({ entry, config }) {
      const execContext: OpenShellExecContext = {
        config: resolveOpenShellPluginConfigFromConfig(config, params.pluginConfig),
        sandboxName: entry.containerName,
      };
      const result = await runOpenShellCli({
        args: ["sandbox", "get", entry.containerName],
        context: execContext,
      });
      const configuredSource = execContext.config.from;
      return {
        actualConfigLabel: entry.image,
        configLabelMatch: entry.image === configuredSource,
        running: result.code === 0,
      };
    },
    async removeRuntime({ entry }) {
      const execContext: OpenShellExecContext = {
        config: params.pluginConfig,
        sandboxName: entry.containerName,
      };
      await runOpenShellCli({
        args: ["sandbox", "delete", entry.containerName],
        context: execContext,
      });
    },
  };
}

async function createOpenShellSandboxBackend(params: {
  pluginConfig: ResolvedOpenShellPluginConfig;
  createParams: CreateSandboxBackendParams;
}): Promise<OpenShellSandboxBackend> {
  if ((params.createParams.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("OpenShell sandbox backend does not support sandbox.docker.binds.");
  }

  const sandboxName = buildOpenShellSandboxName(params.createParams.scopeKey);
  const execContext: OpenShellExecContext = {
    config: params.pluginConfig,
    sandboxName,
  };
  const impl = new OpenShellSandboxBackendImpl({
    createParams: params.createParams,
    execContext,
    remoteAgentWorkspaceDir: params.pluginConfig.remoteAgentWorkspaceDir,
    remoteWorkspaceDir: params.pluginConfig.remoteWorkspaceDir,
  });

  return {
    buildExecSpec: async ({ command, workdir, env, usePty }) => {
      const pending = await impl.prepareExec({ command, env, usePty, workdir });
      return {
        argv: pending.argv,
        env: buildOpenShellSshExecEnv(),
        finalizeToken: pending.token,
        stdinMode: "pipe-open",
      };
    },
    configLabel: params.pluginConfig.from,
    configLabelKind: "Source",
    createFsBridge: ({ sandbox }) =>
      params.pluginConfig.mode === "remote"
        ? createRemoteShellSandboxFsBridge({
            runtime: impl.asHandle(),
            sandbox,
          })
        : createOpenShellFsBridge({
            backend: impl.asHandle(),
            sandbox,
          }),
    env: params.createParams.cfg.docker.env,
    finalizeExec: async ({ token }) => {
      await impl.finalizeExec(token as PendingExec | undefined);
    },
    id: "openshell",
    mode: params.pluginConfig.mode,
    remoteAgentWorkspaceDir: params.pluginConfig.remoteAgentWorkspaceDir,
    remoteWorkspaceDir: params.pluginConfig.remoteWorkspaceDir,
    runRemoteShellScript: async (command) => await impl.runRemoteShellScript(command),
    runShellCommand: async (command) => await impl.runRemoteShellScript(command),
    runtimeId: sandboxName,
    runtimeLabel: sandboxName,
    syncLocalPathToRemote: async (localPath, remotePath) =>
      await impl.syncLocalPathToRemote(localPath, remotePath),
    workdir: params.pluginConfig.remoteWorkspaceDir,
  };
}

class OpenShellSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;
  private remoteSeedPending = false;

  constructor(
    private readonly params: {
      createParams: CreateSandboxBackendParams;
      execContext: OpenShellExecContext;
      remoteWorkspaceDir: string;
      remoteAgentWorkspaceDir: string;
    },
  ) {}

  asHandle(): OpenShellSandboxBackend {
    return {
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        const pending = await this.prepareExec({ command, env, usePty, workdir });
        return {
          argv: pending.argv,
          env: buildOpenShellSshExecEnv(),
          finalizeToken: pending.token,
          stdinMode: "pipe-open",
        };
      },
      configLabel: this.params.execContext.config.from,
      configLabelKind: "Source",
      createFsBridge: ({ sandbox }) =>
        this.params.execContext.config.mode === "remote"
          ? createRemoteShellSandboxFsBridge({
              runtime: this.asHandle(),
              sandbox,
            })
          : createOpenShellFsBridge({
              backend: this.asHandle(),
              sandbox,
            }),
      env: this.params.createParams.cfg.docker.env,
      finalizeExec: async ({ token }) => {
        await this.finalizeExec(token as PendingExec | undefined);
      },
      id: "openshell",
      mode: this.params.execContext.config.mode,
      remoteAgentWorkspaceDir: this.params.remoteAgentWorkspaceDir,
      remoteWorkspaceDir: this.params.remoteWorkspaceDir,
      runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
      runShellCommand: async (command) => await this.runRemoteShellScript(command),
      runtimeId: this.params.execContext.sandboxName,
      runtimeLabel: this.params.execContext.sandboxName,
      syncLocalPathToRemote: async (localPath, remotePath) =>
        await this.syncLocalPathToRemote(localPath, remotePath),
      workdir: this.params.remoteWorkspaceDir,
    };
  }

  async prepareExec(params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }): Promise<{ argv: string[]; token: PendingExec }> {
    await this.ensureSandboxExists();
    if (this.params.execContext.config.mode === "mirror") {
      await this.syncWorkspaceToRemote();
    } else {
      await this.maybeSeedRemoteWorkspace();
    }
    const sshSession = await createOpenShellSshSession({
      context: this.params.execContext,
    });
    const remoteCommand = buildExecRemoteCommand({
      command: params.command,
      env: params.env,
      workdir: params.workdir ?? this.params.remoteWorkspaceDir,
    });
    return {
      argv: [
        "ssh",
        "-F",
        sshSession.configPath,
        ...(params.usePty
          ? ["-tt", "-o", "RequestTTY=force", "-o", "SetEnv=TERM=xterm-256color"]
          : ["-T", "-o", "RequestTTY=no"]),
        sshSession.host,
        remoteCommand,
      ],
      token: { sshSession },
    };
  }

  async finalizeExec(token?: PendingExec): Promise<void> {
    try {
      if (this.params.execContext.config.mode === "mirror") {
        await this.syncWorkspaceFromRemote();
      }
    } finally {
      if (token?.sshSession) {
        await disposeSshSandboxSession(token.sshSession);
      }
    }
  }

  async runRemoteShellScript(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    await this.ensureSandboxExists();
    await this.maybeSeedRemoteWorkspace();
    return await this.runRemoteShellScriptInternal(params);
  }

  private async runRemoteShellScriptInternal(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    const session = await createOpenShellSshSession({
      context: this.params.execContext,
    });
    try {
      return await runSshSandboxCommand({
        allowFailure: params.allowFailure,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          params.script,
          "openclaw-openshell-fs",
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

  async syncLocalPathToRemote(localPath: string, remotePath: string): Promise<void> {
    await this.ensureSandboxExists();
    await this.maybeSeedRemoteWorkspace();
    const stats = await fs.lstat(localPath).catch(() => null);
    if (!stats) {
      await this.runRemoteShellScript({
        allowFailure: true,
        args: [remotePath],
        script: 'rm -rf -- "$1"',
      });
      return;
    }
    if (stats.isSymbolicLink()) {
      await this.runRemoteShellScript({
        allowFailure: true,
        args: [remotePath],
        script: 'rm -rf -- "$1"',
      });
      return;
    }
    if (stats.isDirectory()) {
      await this.runRemoteShellScript({
        args: [remotePath],
        script: 'mkdir -p -- "$1"',
      });
      return;
    }
    await this.runRemoteShellScript({
      args: [remotePath],
      script: 'mkdir -p -- "$(dirname -- "$1")"',
    });
    const result = await runOpenShellCli({
      args: [
        "sandbox",
        "upload",
        "--no-git-ignore",
        this.params.execContext.sandboxName,
        localPath,
        path.posix.dirname(remotePath),
      ],
      context: this.params.execContext,
      cwd: this.params.createParams.workspaceDir,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "openshell sandbox upload failed");
    }
  }

  private async ensureSandboxExists(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    this.ensurePromise = this.ensureSandboxExistsInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureSandboxExistsInner(): Promise<void> {
    const getResult = await runOpenShellCli({
      args: ["sandbox", "get", this.params.execContext.sandboxName],
      context: this.params.execContext,
      cwd: this.params.createParams.workspaceDir,
    });
    if (getResult.code === 0) {
      return;
    }
    const createArgs = [
      "sandbox",
      "create",
      "--name",
      this.params.execContext.sandboxName,
      "--from",
      this.params.execContext.config.from,
      ...(this.params.execContext.config.policy
        ? ["--policy", this.params.execContext.config.policy]
        : []),
      ...(this.params.execContext.config.gpu ? ["--gpu"] : []),
      ...(this.params.execContext.config.autoProviders
        ? ["--auto-providers"]
        : ["--no-auto-providers"]),
      ...this.params.execContext.config.providers.flatMap((provider) => ["--provider", provider]),
      "--",
      "true",
    ];
    const createResult = await runOpenShellCli({
      args: createArgs,
      context: this.params.execContext,
      cwd: this.params.createParams.workspaceDir,
      timeoutMs: Math.max(this.params.execContext.config.timeoutMs, 300_000),
    });
    if (createResult.code !== 0) {
      throw new Error(createResult.stderr.trim() || "openshell sandbox create failed");
    }
    this.remoteSeedPending = true;
  }

  private async syncWorkspaceToRemote(): Promise<void> {
    await this.runRemoteShellScriptInternal({
      args: [this.params.remoteWorkspaceDir],
      script: 'mkdir -p -- "$1" && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
    });
    await this.uploadPathToRemote(
      this.params.createParams.workspaceDir,
      this.params.remoteWorkspaceDir,
    );

    if (
      this.params.createParams.cfg.workspaceAccess !== "none" &&
      path.resolve(this.params.createParams.agentWorkspaceDir) !==
        path.resolve(this.params.createParams.workspaceDir)
    ) {
      await this.runRemoteShellScriptInternal({
        args: [this.params.remoteAgentWorkspaceDir],
        script: 'mkdir -p -- "$1" && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
      });
      await this.uploadPathToRemote(
        this.params.createParams.agentWorkspaceDir,
        this.params.remoteAgentWorkspaceDir,
      );
    }
  }

  private async syncWorkspaceFromRemote(): Promise<void> {
    const tmpDir = await fs.mkdtemp(
      path.join(resolveOpenShellTmpRoot(), "openclaw-openshell-sync-"),
    );
    try {
      const result = await runOpenShellCli({
        args: [
          "sandbox",
          "download",
          this.params.execContext.sandboxName,
          this.params.remoteWorkspaceDir,
          tmpDir,
        ],
        context: this.params.execContext,
        cwd: this.params.createParams.workspaceDir,
      });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "openshell sandbox download failed");
      }
      await replaceDirectoryContents({
        sourceDir: tmpDir,
        targetDir: this.params.createParams.workspaceDir,
        // Never sync trusted host hook directories or repository metadata from
        // The remote sandbox.
        excludeDirs: DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
      });
    } finally {
      await fs.rm(tmpDir, { force: true, recursive: true });
    }
  }

  private async uploadPathToRemote(localPath: string, remotePath: string): Promise<void> {
    const tmpDir = await fs.mkdtemp(
      path.join(resolveOpenShellTmpRoot(), "openclaw-openshell-upload-"),
    );
    try {
      // Stage a symlink-free snapshot so upload never dereferences host paths
      // Outside the mirrored workspace tree.
      await stageDirectoryContents({
        sourceDir: localPath,
        targetDir: tmpDir,
      });
      const result = await runOpenShellCli({
        args: [
          "sandbox",
          "upload",
          "--no-git-ignore",
          this.params.execContext.sandboxName,
          tmpDir,
          remotePath,
        ],
        context: this.params.execContext,
        cwd: this.params.createParams.workspaceDir,
      });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "openshell sandbox upload failed");
      }
    } finally {
      await fs.rm(tmpDir, { force: true, recursive: true });
    }
  }

  private async maybeSeedRemoteWorkspace(): Promise<void> {
    if (!this.remoteSeedPending) {
      return;
    }
    this.remoteSeedPending = false;
    try {
      await this.syncWorkspaceToRemote();
    } catch (error) {
      this.remoteSeedPending = true;
      throw error;
    }
  }
}

function resolveOpenShellPluginConfigFromConfig(
  config: OpenClawConfig,
  fallback: ResolvedOpenShellPluginConfig,
): ResolvedOpenShellPluginConfig {
  const pluginConfig = config.plugins?.entries?.openshell?.config;
  if (!pluginConfig) {
    return fallback;
  }
  return resolveOpenShellPluginConfig(pluginConfig);
}

function buildOpenShellSandboxName(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = [...trimmed].reduce((acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0, 5381);
  return `openclaw-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}

function resolveOpenShellTmpRoot(): string {
  return path.resolve(resolvePreferredOpenClawTmpDir());
}
