import type { OpenClawConfig } from "../../config/config.js";
import type { SandboxSshSettings } from "../../config/types.sandbox.js";
import { normalizeSecretInputString } from "../../config/types.secrets.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveAgentConfig } from "../agent-scope.js";
import {
  DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
  DEFAULT_SANDBOX_BROWSER_CDP_PORT,
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_BROWSER_NETWORK,
  DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
  DEFAULT_SANDBOX_BROWSER_PREFIX,
  DEFAULT_SANDBOX_BROWSER_VNC_PORT,
  DEFAULT_SANDBOX_CONTAINER_PREFIX,
  DEFAULT_SANDBOX_IDLE_HOURS,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_MAX_AGE_DAYS,
  DEFAULT_SANDBOX_WORKDIR,
  DEFAULT_SANDBOX_WORKSPACE_ROOT,
} from "./constants.js";
import { resolveSandboxToolPolicyForAgent } from "./tool-policy.js";
import type {
  SandboxBrowserConfig,
  SandboxConfig,
  SandboxDockerConfig,
  SandboxPruneConfig,
  SandboxScope,
  SandboxSshConfig,
} from "./types.js";

export const DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS = [
  "dangerouslyAllowReservedContainerTargets",
  "dangerouslyAllowExternalBindSources",
  "dangerouslyAllowContainerNamespaceJoin",
] as const;

const DEFAULT_SANDBOX_SSH_COMMAND = "ssh";
const DEFAULT_SANDBOX_SSH_WORKSPACE_ROOT = "/tmp/openclaw-sandboxes";

type DangerousSandboxDockerBooleanKey = (typeof DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS)[number];
type DangerousSandboxDockerBooleans = Pick<SandboxDockerConfig, DangerousSandboxDockerBooleanKey>;

function resolveDangerousSandboxDockerBooleans(
  agentDocker?: Partial<SandboxDockerConfig>,
  globalDocker?: Partial<SandboxDockerConfig>,
): DangerousSandboxDockerBooleans {
  const resolved = {} as DangerousSandboxDockerBooleans;
  for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
    resolved[key] = agentDocker?.[key] ?? globalDocker?.[key];
  }
  return resolved;
}

export function resolveSandboxBrowserDockerCreateConfig(params: {
  docker: SandboxDockerConfig;
  browser: SandboxBrowserConfig;
}): SandboxDockerConfig {
  const browserNetwork = params.browser.network.trim();
  const base: SandboxDockerConfig = {
    ...params.docker,
    // Browser container needs network access for Chrome, downloads, etc.
    network: browserNetwork || DEFAULT_SANDBOX_BROWSER_NETWORK,
    // For hashing and consistency, treat browser image as the docker image even though we
    // Pass it separately as the final `docker create` argument.
    image: params.browser.image,
  };
  return params.browser.binds !== undefined ? { ...base, binds: params.browser.binds } : base;
}

export function resolveSandboxScope(params: {
  scope?: SandboxScope;
  perSession?: boolean;
}): SandboxScope {
  if (params.scope) {
    return params.scope;
  }
  if (typeof params.perSession === "boolean") {
    return params.perSession ? "session" : "shared";
  }
  return "agent";
}

export function resolveSandboxDockerConfig(params: {
  scope: SandboxScope;
  globalDocker?: Partial<SandboxDockerConfig>;
  agentDocker?: Partial<SandboxDockerConfig>;
}): SandboxDockerConfig {
  const agentDocker = params.scope === "shared" ? undefined : params.agentDocker;
  const {globalDocker} = params;

  const env = agentDocker?.env
    ? { ...(globalDocker?.env ?? { LANG: "C.UTF-8" }), ...agentDocker.env }
    : (globalDocker?.env ?? { LANG: "C.UTF-8" });

  const ulimits = agentDocker?.ulimits
    ? { ...globalDocker?.ulimits, ...agentDocker.ulimits }
    : globalDocker?.ulimits;

  const binds = [...(globalDocker?.binds ?? []), ...(agentDocker?.binds ?? [])];

  return {
    apparmorProfile: agentDocker?.apparmorProfile ?? globalDocker?.apparmorProfile,
    binds: binds.length ? binds : undefined,
    capDrop: agentDocker?.capDrop ?? globalDocker?.capDrop ?? ["ALL"],
    containerPrefix:
      agentDocker?.containerPrefix ??
      globalDocker?.containerPrefix ??
      DEFAULT_SANDBOX_CONTAINER_PREFIX,
    cpus: agentDocker?.cpus ?? globalDocker?.cpus,
    dns: agentDocker?.dns ?? globalDocker?.dns,
    env,
    extraHosts: agentDocker?.extraHosts ?? globalDocker?.extraHosts,
    image: agentDocker?.image ?? globalDocker?.image ?? DEFAULT_SANDBOX_IMAGE,
    memory: agentDocker?.memory ?? globalDocker?.memory,
    memorySwap: agentDocker?.memorySwap ?? globalDocker?.memorySwap,
    network: agentDocker?.network ?? globalDocker?.network ?? "none",
    pidsLimit: agentDocker?.pidsLimit ?? globalDocker?.pidsLimit,
    readOnlyRoot: agentDocker?.readOnlyRoot ?? globalDocker?.readOnlyRoot ?? true,
    seccompProfile: agentDocker?.seccompProfile ?? globalDocker?.seccompProfile,
    setupCommand: agentDocker?.setupCommand ?? globalDocker?.setupCommand,
    tmpfs: agentDocker?.tmpfs ?? globalDocker?.tmpfs ?? ["/tmp", "/var/tmp", "/run"],
    ulimits,
    user: agentDocker?.user ?? globalDocker?.user,
    workdir: agentDocker?.workdir ?? globalDocker?.workdir ?? DEFAULT_SANDBOX_WORKDIR,
    ...resolveDangerousSandboxDockerBooleans(agentDocker, globalDocker),
  };
}

export function resolveSandboxBrowserConfig(params: {
  scope: SandboxScope;
  globalBrowser?: Partial<SandboxBrowserConfig>;
  agentBrowser?: Partial<SandboxBrowserConfig>;
}): SandboxBrowserConfig {
  const agentBrowser = params.scope === "shared" ? undefined : params.agentBrowser;
  const {globalBrowser} = params;
  const binds = [...(globalBrowser?.binds ?? []), ...(agentBrowser?.binds ?? [])];
  // Treat `binds: []` as an explicit override, so it can disable `docker.binds` for the browser container.
  const bindsConfigured = globalBrowser?.binds !== undefined || agentBrowser?.binds !== undefined;
  return {
    allowHostControl: agentBrowser?.allowHostControl ?? globalBrowser?.allowHostControl ?? false,
    autoStart: agentBrowser?.autoStart ?? globalBrowser?.autoStart ?? true,
    autoStartTimeoutMs:
      agentBrowser?.autoStartTimeoutMs ??
      globalBrowser?.autoStartTimeoutMs ??
      DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
    binds: bindsConfigured ? binds : undefined,
    cdpPort: agentBrowser?.cdpPort ?? globalBrowser?.cdpPort ?? DEFAULT_SANDBOX_BROWSER_CDP_PORT,
    cdpSourceRange: agentBrowser?.cdpSourceRange ?? globalBrowser?.cdpSourceRange,
    containerPrefix:
      agentBrowser?.containerPrefix ??
      globalBrowser?.containerPrefix ??
      DEFAULT_SANDBOX_BROWSER_PREFIX,
    enableNoVnc: agentBrowser?.enableNoVnc ?? globalBrowser?.enableNoVnc ?? true,
    enabled: agentBrowser?.enabled ?? globalBrowser?.enabled ?? false,
    headless: agentBrowser?.headless ?? globalBrowser?.headless ?? false,
    image: agentBrowser?.image ?? globalBrowser?.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE,
    network: agentBrowser?.network ?? globalBrowser?.network ?? DEFAULT_SANDBOX_BROWSER_NETWORK,
    noVncPort:
      agentBrowser?.noVncPort ?? globalBrowser?.noVncPort ?? DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
    vncPort: agentBrowser?.vncPort ?? globalBrowser?.vncPort ?? DEFAULT_SANDBOX_BROWSER_VNC_PORT,
  };
}

export function resolveSandboxPruneConfig(params: {
  scope: SandboxScope;
  globalPrune?: Partial<SandboxPruneConfig>;
  agentPrune?: Partial<SandboxPruneConfig>;
}): SandboxPruneConfig {
  const agentPrune = params.scope === "shared" ? undefined : params.agentPrune;
  const {globalPrune} = params;
  return {
    idleHours: agentPrune?.idleHours ?? globalPrune?.idleHours ?? DEFAULT_SANDBOX_IDLE_HOURS,
    maxAgeDays: agentPrune?.maxAgeDays ?? globalPrune?.maxAgeDays ?? DEFAULT_SANDBOX_MAX_AGE_DAYS,
  };
}

function normalizeRemoteRoot(value: string | undefined, fallback: string): string {
  const normalized = normalizeOptionalString(value) ?? fallback;
  const posix = normalized.replaceAll("\\", "/");
  if (!posix.startsWith("/")) {
    throw new Error(`Sandbox SSH workspaceRoot must be an absolute POSIX path: ${normalized}`);
  }
  return posix.replace(/\/+$/g, "") || "/";
}

export function resolveSandboxSshConfig(params: {
  scope: SandboxScope;
  globalSsh?: Partial<SandboxSshSettings>;
  agentSsh?: Partial<SandboxSshSettings>;
}): SandboxSshConfig {
  const agentSsh = params.scope === "shared" ? undefined : params.agentSsh;
  const {globalSsh} = params;
  return {
    certificateData: normalizeSecretInputString(
      agentSsh?.certificateData ?? globalSsh?.certificateData,
    ),
    certificateFile: normalizeOptionalString(
      agentSsh?.certificateFile ?? globalSsh?.certificateFile,
    ),
    command:
      normalizeOptionalString(agentSsh?.command ?? globalSsh?.command) ??
      DEFAULT_SANDBOX_SSH_COMMAND,
    identityData: normalizeSecretInputString(agentSsh?.identityData ?? globalSsh?.identityData),
    identityFile: normalizeOptionalString(agentSsh?.identityFile ?? globalSsh?.identityFile),
    knownHostsData: normalizeSecretInputString(
      agentSsh?.knownHostsData ?? globalSsh?.knownHostsData,
    ),
    knownHostsFile: normalizeOptionalString(agentSsh?.knownHostsFile ?? globalSsh?.knownHostsFile),
    strictHostKeyChecking:
      agentSsh?.strictHostKeyChecking ?? globalSsh?.strictHostKeyChecking ?? true,
    target: normalizeOptionalString(agentSsh?.target ?? globalSsh?.target),
    updateHostKeys: agentSsh?.updateHostKeys ?? globalSsh?.updateHostKeys ?? true,
    workspaceRoot: normalizeRemoteRoot(
      agentSsh?.workspaceRoot ?? globalSsh?.workspaceRoot,
      DEFAULT_SANDBOX_SSH_WORKSPACE_ROOT,
    ),
  };
}

export function resolveSandboxConfigForAgent(
  cfg?: OpenClawConfig,
  agentId?: string,
): SandboxConfig {
  const agent = cfg?.agents?.defaults?.sandbox;

  // Agent-specific sandbox config overrides global
  let agentSandbox: typeof agent | undefined;
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  if (agentConfig?.sandbox) {
    agentSandbox = agentConfig.sandbox;
  }
  const legacyAgentSandbox = agentSandbox as
    | (typeof agentSandbox & { perSession?: boolean })
    | undefined;
  const legacyDefaultSandbox = agent as (typeof agent & { perSession?: boolean }) | undefined;

  const scope = resolveSandboxScope({
    perSession: legacyAgentSandbox?.perSession ?? legacyDefaultSandbox?.perSession,
    scope: agentSandbox?.scope ?? agent?.scope,
  });

  const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, agentId);

  return {
    backend: agentSandbox?.backend?.trim() || agent?.backend?.trim() || "docker",
    browser: resolveSandboxBrowserConfig({
      agentBrowser: agentSandbox?.browser,
      globalBrowser: agent?.browser,
      scope,
    }),
    docker: resolveSandboxDockerConfig({
      agentDocker: agentSandbox?.docker,
      globalDocker: agent?.docker,
      scope,
    }),
    mode: agentSandbox?.mode ?? agent?.mode ?? "off",
    prune: resolveSandboxPruneConfig({
      agentPrune: agentSandbox?.prune,
      globalPrune: agent?.prune,
      scope,
    }),
    scope,
    ssh: resolveSandboxSshConfig({
      agentSsh: agentSandbox?.ssh,
      globalSsh: agent?.ssh,
      scope,
    }),
    tools: {
      allow: toolPolicy.allow,
      deny: toolPolicy.deny,
    },
    workspaceAccess: agentSandbox?.workspaceAccess ?? agent?.workspaceAccess ?? "none",
    workspaceRoot:
      agentSandbox?.workspaceRoot ?? agent?.workspaceRoot ?? DEFAULT_SANDBOX_WORKSPACE_ROOT,
  };
}
