import type { SandboxContext, SandboxToolPolicy, SandboxWorkspaceAccess } from "../sandbox.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";

interface PiToolsSandboxContextParams {
  workspaceDir: string;
  agentWorkspaceDir?: string;
  workspaceAccess?: SandboxWorkspaceAccess;
  fsBridge?: SandboxFsBridge;
  tools?: SandboxToolPolicy;
  browserAllowHostControl?: boolean;
  sessionKey?: string;
  containerName?: string;
  containerWorkdir?: string;
  dockerOverrides?: Partial<SandboxContext["docker"]>;
}

export function createPiToolsSandboxContext(params: PiToolsSandboxContextParams): SandboxContext {
  const { workspaceDir } = params;
  return {
    agentWorkspaceDir: params.agentWorkspaceDir ?? workspaceDir,
    backendId: "docker",
    browserAllowHostControl: params.browserAllowHostControl ?? false,
    containerName: params.containerName ?? "openclaw-sbx-test",
    containerWorkdir: params.containerWorkdir ?? "/workspace",
    docker: {
      capDrop: ["ALL"],
      containerPrefix: "openclaw-sbx-",
      env: { LANG: "C.UTF-8" },
      image: "openclaw-sandbox:bookworm-slim",
      network: "none",
      readOnlyRoot: true,
      tmpfs: [],
      user: "1000:1000",
      workdir: "/workspace",
      ...params.dockerOverrides,
    },
    enabled: true,
    fsBridge: params.fsBridge,
    runtimeId: params.containerName ?? "openclaw-sbx-test",
    runtimeLabel: params.containerName ?? "openclaw-sbx-test",
    sessionKey: params.sessionKey ?? "sandbox:test",
    tools: params.tools ?? { allow: [], deny: [] },
    workspaceAccess: params.workspaceAccess ?? "rw",
    workspaceDir,
  };
}
