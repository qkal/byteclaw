import type { SandboxContext } from "./types.js";

export function createSandboxTestContext(params?: {
  overrides?: Partial<SandboxContext>;
  dockerOverrides?: Partial<SandboxContext["docker"]>;
}): SandboxContext {
  const overrides = params?.overrides ?? {};
  const { docker: _unusedDockerOverrides, ...sandboxOverrides } = overrides;
  const docker = {
    apparmorProfile: "",
    binds: [],
    capDrop: [],
    containerPrefix: "openclaw-sbx-",
    dns: [],
    extraHosts: [],
    image: "openclaw-sandbox:bookworm-slim",
    network: "none",
    pidsLimit: 0,
    readOnlyRoot: false,
    seccompProfile: "",
    setupCommand: "",
    tmpfs: [],
    user: "1000:1000",
    workdir: "/workspace",
    ...overrides.docker,
    ...params?.dockerOverrides,
  };

  return {
    enabled: true,
    backendId: "docker",
    sessionKey: "sandbox:test",
    workspaceDir: "/tmp/workspace",
    agentWorkspaceDir: "/tmp/workspace",
    workspaceAccess: "rw",
    runtimeId: "openclaw-sbx-test",
    runtimeLabel: "openclaw-sbx-test",
    containerName: "openclaw-sbx-test",
    containerWorkdir: "/workspace",
    tools: { allow: ["*"], deny: [] },
    browserAllowHostControl: false,
    ...sandboxOverrides,
    docker,
  };
}
