import { buildDockerExecArgs } from "../bash-tools.shared.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendCommandParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  dockerContainerState,
  ensureSandboxContainer,
  execDocker,
  execDockerRaw,
} from "./docker.js";

function resolveConfiguredDockerRuntimeImage(params: {
  config: CreateSandboxBackendParams["cfg"] | import("../../config/config.js").OpenClawConfig;
  agentId?: string;
  configLabelKind?: string;
}): string {
  const sandboxCfg = resolveSandboxConfigForAgent(params.config, params.agentId);
  switch (params.configLabelKind) {
    case "BrowserImage": {
      return sandboxCfg.browser.image;
    }
    case "Image":
    case undefined:
    default: {
      return sandboxCfg.docker.image;
    }
  }
}

export async function createDockerSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  const containerName = await ensureSandboxContainer({
    agentWorkspaceDir: params.agentWorkspaceDir,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
  return createDockerSandboxBackendHandle({
    containerName,
    env: params.cfg.docker.env,
    image: params.cfg.docker.image,
    workdir: params.cfg.docker.workdir,
  });
}

export function createDockerSandboxBackendHandle(params: {
  containerName: string;
  workdir: string;
  env?: Record<string, string>;
  image: string;
}): SandboxBackendHandle {
  return {
    async buildExecSpec({ command, workdir, env, usePty }) {
      return {
        argv: [
          "docker",
          ...buildDockerExecArgs({
            command,
            containerName: params.containerName,
            env,
            tty: usePty,
            workdir: workdir ?? params.workdir,
          }),
        ],
        env: process.env,
        stdinMode: usePty ? "pipe-open" : "pipe-closed",
      };
    },
    capabilities: {
      browser: true,
    },
    configLabel: params.image,
    configLabelKind: "Image",
    env: params.env,
    id: "docker",
    runShellCommand(command) {
      return runDockerSandboxShellCommand({
        containerName: params.containerName,
        ...command,
      });
    },
    runtimeId: params.containerName,
    runtimeLabel: params.containerName,
    workdir: params.workdir,
  };
}

export function runDockerSandboxShellCommand(
  params: {
    containerName: string;
  } & SandboxBackendCommandParams,
) {
  const dockerArgs = [
    "exec",
    "-i",
    params.containerName,
    "sh",
    "-c",
    params.script,
    "openclaw-sandbox-fs",
  ];
  if (params.args?.length) {
    dockerArgs.push(...params.args);
  }
  return execDockerRaw(dockerArgs, {
    allowFailure: params.allowFailure,
    input: params.stdin,
    signal: params.signal,
  });
}

export const dockerSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime({ entry, config, agentId }) {
    const state = await dockerContainerState(entry.containerName);
    let actualConfigLabel = entry.image;
    if (state.exists) {
      try {
        const result = await execDocker(
          ["inspect", "-f", "{{.Config.Image}}", entry.containerName],
          { allowFailure: true },
        );
        if (result.code === 0) {
          actualConfigLabel = result.stdout.trim() || actualConfigLabel;
        }
      } catch {
        // Ignore inspect failures
      }
    }
    const configuredImage = resolveConfiguredDockerRuntimeImage({
      agentId,
      config,
      configLabelKind: entry.configLabelKind,
    });
    return {
      actualConfigLabel,
      configLabelMatch: actualConfigLabel === configuredImage,
      running: state.running,
    };
  },
  async removeRuntime({ entry }) {
    try {
      await execDocker(["rm", "-f", entry.containerName], { allowFailure: true });
    } catch {
      // Ignore removal failures
    }
  },
};
