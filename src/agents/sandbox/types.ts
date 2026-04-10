import type { SandboxBackendHandle, SandboxBackendId } from "./backend-handle.types.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";
import type { SandboxDockerConfig } from "./types.docker.js";

export type { SandboxDockerConfig } from "./types.docker.js";

export interface SandboxToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface SandboxToolPolicySource {
  source: "agent" | "global" | "default";
  /**
   * Config key path hint for humans.
   * (Arrays use `agents.list[].…` form.)
   */
  key: string;
}

export interface SandboxToolPolicyResolved {
  allow: string[];
  deny: string[];
  sources: {
    allow: SandboxToolPolicySource;
    deny: SandboxToolPolicySource;
  };
}

export type SandboxWorkspaceAccess = "none" | "ro" | "rw";

export interface SandboxBrowserConfig {
  enabled: boolean;
  image: string;
  containerPrefix: string;
  network: string;
  cdpPort: number;
  cdpSourceRange?: string;
  vncPort: number;
  noVncPort: number;
  headless: boolean;
  enableNoVnc: boolean;
  allowHostControl: boolean;
  autoStart: boolean;
  autoStartTimeoutMs: number;
  binds?: string[];
}

export interface SandboxPruneConfig {
  idleHours: number;
  maxAgeDays: number;
}

export interface SandboxSshConfig {
  target?: string;
  command: string;
  workspaceRoot: string;
  strictHostKeyChecking: boolean;
  updateHostKeys: boolean;
  identityFile?: string;
  certificateFile?: string;
  knownHostsFile?: string;
  identityData?: string;
  certificateData?: string;
  knownHostsData?: string;
}

export type SandboxScope = "session" | "agent" | "shared";

export interface SandboxConfig {
  mode: "off" | "non-main" | "all";
  backend: SandboxBackendId;
  scope: SandboxScope;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceRoot: string;
  docker: SandboxDockerConfig;
  ssh: SandboxSshConfig;
  browser: SandboxBrowserConfig;
  tools: SandboxToolPolicy;
  prune: SandboxPruneConfig;
}

export interface SandboxBrowserContext {
  bridgeUrl: string;
  noVncUrl?: string;
  containerName: string;
}

export interface SandboxContext {
  enabled: boolean;
  backendId: SandboxBackendId;
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  runtimeId: string;
  runtimeLabel: string;
  containerName: string;
  containerWorkdir: string;
  docker: SandboxDockerConfig;
  tools: SandboxToolPolicy;
  browserAllowHostControl: boolean;
  browser?: SandboxBrowserContext;
  fsBridge?: SandboxFsBridge;
  backend?: SandboxBackendHandle;
}

export interface SandboxWorkspaceInfo {
  workspaceDir: string;
  containerWorkdir: string;
}
