import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadConfig,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
} from "../config/config.js";
import { loadConfig as loadConfigFromIo } from "../config/io.js";
import {
  resolveConfigPath as resolveConfigPathFromPaths,
  resolveGatewayPort as resolveGatewayPortFromPaths,
  resolveStateDir as resolveStateDirFromPaths,
} from "../config/paths.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import { resolveSecretInputString } from "../secrets/resolve-secret-input-string.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { VERSION } from "../version.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import {
  type GatewayConnectionDetails,
  buildGatewayConnectionDetailsWithResolvers,
} from "./connection-details.js";
import {
  type ExplicitGatewayAuth,
  type GatewayCredentialMode,
  type GatewayCredentialPrecedence,
  type GatewayRemoteCredentialFallback,
  type GatewayRemoteCredentialPrecedence,
  GatewaySecretRefUnavailableError,
  resolveGatewayCredentialsFromConfig,
  trimToUndefined,
} from "./credentials.js";
import { canSkipGatewayConfigLoad } from "./explicit-connection-policy.js";
import {
  CLI_DEFAULT_OPERATOR_SCOPES,
  type OperatorScope,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import {
  ALL_GATEWAY_SECRET_INPUT_PATHS,
  type SupportedGatewaySecretInputPath,
  assignResolvedGatewaySecretInput,
  isSupportedGatewaySecretInputPath,
  isTokenGatewaySecretInputPath,
  readGatewaySecretInputValue,
} from "./secret-input-paths.js";
export type { GatewayConnectionDetails };

interface CallGatewayBaseOptions {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  config?: OpenClawConfig;
  method: string;
  params?: unknown;
  expectFinal?: boolean;
  timeoutMs?: number;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  minProtocol?: number;
  maxProtocol?: number;
  requiredMethods?: string[];
  /**
   * Overrides the config path shown in connection error details.
   * Does not affect config loading; callers still control auth via opts.token/password/env/config.
   */
  configPath?: string;
}

export type CallGatewayScopedOptions = CallGatewayBaseOptions & {
  scopes: OperatorScope[];
};

export type CallGatewayCliOptions = CallGatewayBaseOptions & {
  scopes?: OperatorScope[];
};

export type CallGatewayOptions = CallGatewayBaseOptions & {
  scopes?: OperatorScope[];
};

const defaultCreateGatewayClient = (opts: GatewayClientOptions) => new GatewayClient(opts);
const defaultGatewayCallDeps = {
  createGatewayClient: defaultCreateGatewayClient,
  loadConfig,
  loadGatewayTlsRuntime,
  loadOrCreateDeviceIdentity,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
};
const gatewayCallDeps = {
  ...defaultGatewayCallDeps,
};

function resolveGatewayClientDisplayName(opts: CallGatewayBaseOptions): string | undefined {
  if (opts.clientDisplayName) {
    return opts.clientDisplayName;
  }
  const clientName = opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI;
  const mode = opts.mode ?? GATEWAY_CLIENT_MODES.CLI;
  if (mode !== GATEWAY_CLIENT_MODES.BACKEND && clientName !== GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT) {
    return undefined;
  }
  const method = opts.method.trim();
  return method ? `gateway:${method}` : "gateway:request";
}

function loadGatewayConfig(): OpenClawConfig {
  const loadConfigFn =
    typeof gatewayCallDeps.loadConfig === "function"
      ? gatewayCallDeps.loadConfig
      : typeof defaultGatewayCallDeps.loadConfig === "function"
        ? defaultGatewayCallDeps.loadConfig
        : loadConfigFromIo;
  return loadConfigFn();
}

function resolveGatewayStateDir(env: NodeJS.ProcessEnv): string {
  const resolveStateDirFn =
    typeof gatewayCallDeps.resolveStateDir === "function"
      ? gatewayCallDeps.resolveStateDir
      : resolveStateDirFromPaths;
  return resolveStateDirFn(env);
}

function resolveGatewayConfigPath(env: NodeJS.ProcessEnv): string {
  const resolveConfigPathFn =
    typeof gatewayCallDeps.resolveConfigPath === "function"
      ? gatewayCallDeps.resolveConfigPath
      : resolveConfigPathFromPaths;
  return resolveConfigPathFn(env, resolveGatewayStateDir(env));
}

function resolveGatewayPortValue(config?: OpenClawConfig, env?: NodeJS.ProcessEnv): number {
  const resolveGatewayPortFn =
    typeof gatewayCallDeps.resolveGatewayPort === "function"
      ? gatewayCallDeps.resolveGatewayPort
      : resolveGatewayPortFromPaths;
  return resolveGatewayPortFn(config, env);
}

export function buildGatewayConnectionDetails(
  options: {
    config?: OpenClawConfig;
    url?: string;
    configPath?: string;
    urlSource?: "cli" | "env";
  } = {},
): GatewayConnectionDetails {
  return buildGatewayConnectionDetailsWithResolvers(options, {
    loadConfig: () => loadGatewayConfig(),
    resolveConfigPath: (env) => resolveGatewayConfigPath(env),
    resolveGatewayPort: (config, env) => resolveGatewayPortValue(config, env),
  });
}

export const __testing = {
  resetDepsForTests(): void {
    gatewayCallDeps.createGatewayClient = defaultGatewayCallDeps.createGatewayClient;
    gatewayCallDeps.loadConfig = defaultGatewayCallDeps.loadConfig;
    gatewayCallDeps.loadOrCreateDeviceIdentity = defaultGatewayCallDeps.loadOrCreateDeviceIdentity;
    gatewayCallDeps.resolveGatewayPort = defaultGatewayCallDeps.resolveGatewayPort;
    gatewayCallDeps.resolveConfigPath = defaultGatewayCallDeps.resolveConfigPath;
    gatewayCallDeps.resolveStateDir = defaultGatewayCallDeps.resolveStateDir;
    gatewayCallDeps.loadGatewayTlsRuntime = defaultGatewayCallDeps.loadGatewayTlsRuntime;
  },
  setCreateGatewayClientForTests(createGatewayClient?: typeof defaultCreateGatewayClient): void {
    gatewayCallDeps.createGatewayClient =
      createGatewayClient ?? defaultGatewayCallDeps.createGatewayClient;
  },
  setDepsForTests(deps: Partial<typeof defaultGatewayCallDeps> | undefined): void {
    gatewayCallDeps.createGatewayClient =
      deps?.createGatewayClient ?? defaultGatewayCallDeps.createGatewayClient;
    gatewayCallDeps.loadConfig = deps?.loadConfig ?? defaultGatewayCallDeps.loadConfig;
    gatewayCallDeps.loadOrCreateDeviceIdentity =
      deps?.loadOrCreateDeviceIdentity ?? defaultGatewayCallDeps.loadOrCreateDeviceIdentity;
    gatewayCallDeps.resolveGatewayPort =
      deps?.resolveGatewayPort ?? defaultGatewayCallDeps.resolveGatewayPort;
    gatewayCallDeps.resolveConfigPath =
      deps?.resolveConfigPath ?? defaultGatewayCallDeps.resolveConfigPath;
    gatewayCallDeps.resolveStateDir =
      deps?.resolveStateDir ?? defaultGatewayCallDeps.resolveStateDir;
    gatewayCallDeps.loadGatewayTlsRuntime =
      deps?.loadGatewayTlsRuntime ?? defaultGatewayCallDeps.loadGatewayTlsRuntime;
  },
};

function resolveDeviceIdentityForGatewayCall(): ReturnType<
  typeof loadOrCreateDeviceIdentity
> | null {
  // Shared-auth local calls should still stay device-bound so operator scopes
  // Remain available for detail RPCs such as status / system-presence /
  // Last-heartbeat.
  try {
    return gatewayCallDeps.loadOrCreateDeviceIdentity();
  } catch {
    // Read-only or restricted environments should still be able to call the
    // Gateway with token/password auth without crashing before the RPC.
    return null;
  }
}

export type { ExplicitGatewayAuth } from "./credentials.js";

export function resolveExplicitGatewayAuth(opts?: ExplicitGatewayAuth): ExplicitGatewayAuth {
  const token =
    typeof opts?.token === "string" && opts.token.trim().length > 0 ? opts.token.trim() : undefined;
  const password =
    typeof opts?.password === "string" && opts.password.trim().length > 0
      ? opts.password.trim()
      : undefined;
  return { password, token };
}

export function ensureExplicitGatewayAuth(params: {
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  explicitAuth?: ExplicitGatewayAuth;
  resolvedAuth?: ExplicitGatewayAuth;
  errorHint: string;
  configPath?: string;
}): void {
  if (!params.urlOverride) {
    return;
  }
  // URL overrides are untrusted redirects and can move WebSocket traffic off the intended host.
  // Never allow an override to silently reuse implicit credentials or device token fallback.
  const explicitToken = params.explicitAuth?.token;
  const explicitPassword = params.explicitAuth?.password;
  if (params.urlOverrideSource === "cli" && (explicitToken || explicitPassword)) {
    return;
  }
  const hasResolvedAuth =
    params.resolvedAuth?.token ||
    params.resolvedAuth?.password ||
    explicitToken ||
    explicitPassword;
  // Env overrides are supported for deployment ergonomics, but only when explicit auth is available.
  // This avoids implicit device-token fallback against attacker-controlled WSS endpoints.
  if (params.urlOverrideSource === "env" && hasResolvedAuth) {
    return;
  }
  const message = [
    "gateway url override requires explicit credentials",
    params.errorHint,
    params.configPath ? `Config: ${params.configPath}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  throw new Error(message);
}

interface GatewayRemoteSettings {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
}

interface ResolvedGatewayCallContext {
  config: OpenClawConfig;
  configPath: string;
  isRemoteMode: boolean;
  remote?: GatewayRemoteSettings;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  remoteUrl?: string;
  explicitAuth: ExplicitGatewayAuth;
  modeOverride?: GatewayCredentialMode;
  localTokenPrecedence?: GatewayCredentialPrecedence;
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
}

function resolveGatewayCallTimeout(timeoutValue: unknown): {
  timeoutMs: number;
  safeTimerTimeoutMs: number;
} {
  const timeoutMs =
    typeof timeoutValue === "number" && Number.isFinite(timeoutValue) ? timeoutValue : 10_000;
  const safeTimerTimeoutMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647));
  return { safeTimerTimeoutMs, timeoutMs };
}

function resolveGatewayCallContext(opts: CallGatewayBaseOptions): ResolvedGatewayCallContext {
  const cliUrlOverride = trimToUndefined(opts.url);
  const explicitAuth = resolveExplicitGatewayAuth({ password: opts.password, token: opts.token });
  const envUrlOverride = cliUrlOverride
    ? undefined
    : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);
  const urlOverride = cliUrlOverride ?? envUrlOverride;
  const urlOverrideSource = cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined;
  const canSkipConfigLoad = canSkipGatewayConfigLoad({
    config: opts.config,
    explicitAuth,
    urlOverride,
  });
  const config = opts.config ?? (canSkipConfigLoad ? ({} as OpenClawConfig) : loadGatewayConfig());
  const configPath = opts.configPath ?? resolveGatewayConfigPath(process.env);
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode
    ? (config.gateway?.remote as GatewayRemoteSettings | undefined)
    : undefined;
  const remoteUrl = trimToUndefined(remote?.url);
  return {
    config,
    configPath,
    explicitAuth,
    isRemoteMode,
    remote,
    remoteUrl,
    urlOverride,
    urlOverrideSource,
  };
}

function ensureRemoteModeUrlConfigured(context: ResolvedGatewayCallContext): void {
  if (!context.isRemoteMode || context.urlOverride || context.remoteUrl) {
    return;
  }
  throw new Error(
    [
      "gateway remote mode misconfigured: gateway.remote.url missing",
      `Config: ${context.configPath}`,
      "Fix: set gateway.remote.url, or set gateway.mode=local.",
    ].join("\n"),
  );
}

async function resolveGatewaySecretInputString(params: {
  config: OpenClawConfig;
  value: unknown;
  path: string;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const value = await resolveSecretInputString({
    config: params.config,
    env: params.env,
    normalize: trimToUndefined,
    onResolveRefError: () => {
      throw new GatewaySecretRefUnavailableError(params.path);
    },
    value: params.value,
  });
  if (!value) {
    throw new Error(`${params.path} resolved to an empty or non-string value.`);
  }
  return value;
}

async function resolveGatewayCredentials(context: ResolvedGatewayCallContext): Promise<{
  token?: string;
  password?: string;
}> {
  return resolveGatewayCredentialsWithEnv(context, process.env);
}

async function resolveGatewayCredentialsWithEnv(
  context: ResolvedGatewayCallContext,
  env: NodeJS.ProcessEnv,
): Promise<{
  token?: string;
  password?: string;
}> {
  if (context.explicitAuth.token || context.explicitAuth.password) {
    return {
      password: context.explicitAuth.password,
      token: context.explicitAuth.token,
    };
  }
  return resolveGatewayCredentialsFromConfigWithSecretInputs({ context, env });
}

function hasConfiguredGatewaySecretRef(
  config: OpenClawConfig,
  path: SupportedGatewaySecretInputPath,
): boolean {
  return Boolean(
    resolveSecretInputRef({
      defaults: config.secrets?.defaults,
      value: readGatewaySecretInputValue(config, path),
    }).ref,
  );
}

function resolveGatewayCredentialsFromConfigOptions(params: {
  context: ResolvedGatewayCallContext;
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
}) {
  const { context, env, cfg } = params;
  return {
    cfg,
    env,
    explicitAuth: context.explicitAuth,
    urlOverride: context.urlOverride,
    urlOverrideSource: context.urlOverrideSource,
    modeOverride: context.modeOverride,
    localTokenPrecedence: context.localTokenPrecedence,
    localPasswordPrecedence: context.localPasswordPrecedence,
    remoteTokenPrecedence: context.remoteTokenPrecedence,
    remotePasswordPrecedence: context.remotePasswordPrecedence ?? "env-first", // Pragma: allowlist secret
    remoteTokenFallback: context.remoteTokenFallback,
    remotePasswordFallback: context.remotePasswordFallback,
  } as const;
}

function localAuthModeAllowsGatewaySecretInputPath(params: {
  authMode: string | undefined;
  path: SupportedGatewaySecretInputPath;
}): boolean {
  const { authMode, path } = params;
  if (authMode === "none" || authMode === "trusted-proxy") {
    return false;
  }
  if (authMode === "token") {
    return isTokenGatewaySecretInputPath(path);
  }
  if (authMode === "password") {
    return !isTokenGatewaySecretInputPath(path);
  }
  return true;
}

function gatewaySecretInputPathCanWin(params: {
  context: ResolvedGatewayCallContext;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
}): boolean {
  if (!hasConfiguredGatewaySecretRef(params.config, params.path)) {
    return false;
  }
  const mode: GatewayCredentialMode =
    params.context.modeOverride ?? (params.config.gateway?.mode === "remote" ? "remote" : "local");
  if (
    mode === "local" &&
    !localAuthModeAllowsGatewaySecretInputPath({
      authMode: params.config.gateway?.auth?.mode,
      path: params.path,
    })
  ) {
    return false;
  }
  const sentinel = `__OPENCLAW_GATEWAY_SECRET_REF_PROBE_${params.path.replaceAll(".", "_")}__`;
  const probeConfig = structuredClone(params.config);
  for (const candidatePath of ALL_GATEWAY_SECRET_INPUT_PATHS) {
    if (!hasConfiguredGatewaySecretRef(probeConfig, candidatePath)) {
      continue;
    }
    assignResolvedGatewaySecretInput({
      config: probeConfig,
      path: candidatePath,
      value: undefined,
    });
  }
  assignResolvedGatewaySecretInput({
    config: probeConfig,
    path: params.path,
    value: sentinel,
  });
  try {
    const resolved = resolveGatewayCredentialsFromConfig(
      resolveGatewayCredentialsFromConfigOptions({
        cfg: probeConfig,
        context: params.context,
        env: params.env,
      }),
    );
    const tokenCanWin = resolved.token === sentinel && !resolved.password;
    const passwordCanWin = resolved.password === sentinel && !resolved.token;
    return tokenCanWin || passwordCanWin;
  } catch {
    return false;
  }
}

async function resolveConfiguredGatewaySecretInput(params: {
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  return resolveGatewaySecretInputString({
    config: params.config,
    env: params.env,
    path: params.path,
    value: readGatewaySecretInputValue(params.config, params.path),
  });
}

async function resolvePreferredGatewaySecretInputs(params: {
  context: ResolvedGatewayCallContext;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
}): Promise<OpenClawConfig> {
  let nextConfig = params.config;
  for (const path of ALL_GATEWAY_SECRET_INPUT_PATHS) {
    if (
      !gatewaySecretInputPathCanWin({
        config: nextConfig,
        context: params.context,
        env: params.env,
        path,
      })
    ) {
      continue;
    }
    if (nextConfig === params.config) {
      nextConfig = structuredClone(params.config);
    }
    try {
      const resolvedValue = await resolveConfiguredGatewaySecretInput({
        config: nextConfig,
        env: params.env,
        path,
      });
      assignResolvedGatewaySecretInput({
        config: nextConfig,
        path,
        value: resolvedValue,
      });
    } catch {
      // Keep scanning candidate paths so unresolved higher-priority refs do not
      // Prevent valid fallback refs from being considered.
      continue;
    }
  }
  return nextConfig;
}

async function resolveGatewayCredentialsFromConfigWithSecretInputs(params: {
  context: ResolvedGatewayCallContext;
  env: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  let resolvedConfig = await resolvePreferredGatewaySecretInputs({
    config: params.context.config,
    context: params.context,
    env: params.env,
  });
  const resolvedPaths = new Set<SupportedGatewaySecretInputPath>();
  for (;;) {
    try {
      return resolveGatewayCredentialsFromConfig(
        resolveGatewayCredentialsFromConfigOptions({
          cfg: resolvedConfig,
          context: params.context,
          env: params.env,
        }),
      );
    } catch (error) {
      if (!(error instanceof GatewaySecretRefUnavailableError)) {
        throw error;
      }
      const { path } = error;
      if (!isSupportedGatewaySecretInputPath(path) || resolvedPaths.has(path)) {
        throw error;
      }
      if (resolvedConfig === params.context.config) {
        resolvedConfig = structuredClone(params.context.config);
      }
      const resolvedValue = await resolveConfiguredGatewaySecretInput({
        config: resolvedConfig,
        env: params.env,
        path,
      });
      assignResolvedGatewaySecretInput({
        config: resolvedConfig,
        path,
        value: resolvedValue,
      });
      resolvedPaths.add(path);
    }
  }
}

export async function resolveGatewayCredentialsWithSecretInputs(params: {
  config: OpenClawConfig;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  env?: NodeJS.ProcessEnv;
  modeOverride?: GatewayCredentialMode;
  localTokenPrecedence?: GatewayCredentialPrecedence;
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
}): Promise<{ token?: string; password?: string }> {
  const { modeOverride } = params;
  const isRemoteMode = modeOverride
    ? modeOverride === "remote"
    : params.config.gateway?.mode === "remote";
  const remoteFromConfig =
    params.config.gateway?.mode === "remote"
      ? (params.config.gateway?.remote as GatewayRemoteSettings | undefined)
      : undefined;
  const remoteFromOverride =
    modeOverride === "remote"
      ? (params.config.gateway?.remote as GatewayRemoteSettings | undefined)
      : undefined;
  const context: ResolvedGatewayCallContext = {
    config: params.config,
    configPath: resolveGatewayConfigPath(process.env),
    explicitAuth: resolveExplicitGatewayAuth(params.explicitAuth),
    isRemoteMode,
    localPasswordPrecedence: params.localPasswordPrecedence,
    localTokenPrecedence: params.localTokenPrecedence,
    modeOverride,
    remote: remoteFromOverride ?? remoteFromConfig,
    remotePasswordFallback: params.remotePasswordFallback,
    remotePasswordPrecedence: params.remotePasswordPrecedence,
    remoteTokenFallback: params.remoteTokenFallback,
    remoteTokenPrecedence: params.remoteTokenPrecedence,
    remoteUrl: isRemoteMode
      ? trimToUndefined((params.config.gateway?.remote as GatewayRemoteSettings | undefined)?.url)
      : undefined,
    urlOverride: trimToUndefined(params.urlOverride),
    urlOverrideSource: params.urlOverrideSource,
  };
  return resolveGatewayCredentialsWithEnv(context, params.env ?? process.env);
}

async function resolveGatewayTlsFingerprint(params: {
  opts: CallGatewayBaseOptions;
  context: ResolvedGatewayCallContext;
  url: string;
}): Promise<string | undefined> {
  const { opts, context, url } = params;
  const useLocalTls =
    context.config.gateway?.tls?.enabled === true &&
    !context.urlOverrideSource &&
    !context.remoteUrl &&
    url.startsWith("wss://");
  const tlsRuntime = useLocalTls
    ? await gatewayCallDeps.loadGatewayTlsRuntime(context.config.gateway?.tls)
    : undefined;
  const overrideTlsFingerprint = trimToUndefined(opts.tlsFingerprint);
  const remoteTlsFingerprint =
    // Env overrides may still inherit configured remote TLS pinning for private cert deployments.
    // CLI overrides remain explicit-only and intentionally skip config remote TLS to avoid
    // Accidentally pinning against caller-supplied target URLs.
    context.isRemoteMode && context.urlOverrideSource !== "cli"
      ? trimToUndefined(context.remote?.tlsFingerprint)
      : undefined;
  return (
    overrideTlsFingerprint ||
    remoteTlsFingerprint ||
    (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined)
  );
}

function formatGatewayCloseError(
  code: number,
  reason: string,
  connectionDetails: GatewayConnectionDetails,
): string {
  const reasonText = normalizeOptionalString(reason) || "no close reason";
  const hint =
    code === 1006 ? "abnormal closure (no close frame)" : code === 1000 ? "normal closure" : "";
  const suffix = hint ? ` ${hint}` : "";
  return `gateway closed (${code}${suffix}): ${reasonText}\n${connectionDetails.message}`;
}

function formatGatewayTimeoutError(
  timeoutMs: number,
  connectionDetails: GatewayConnectionDetails,
): string {
  return `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
}

function ensureGatewaySupportsRequiredMethods(params: {
  requiredMethods: string[] | undefined;
  methods: string[] | undefined;
  attemptedMethod: string;
}): void {
  const requiredMethods = Array.isArray(params.requiredMethods)
    ? params.requiredMethods.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
  if (requiredMethods.length === 0) {
    return;
  }
  const supportedMethods = new Set(
    (Array.isArray(params.methods) ? params.methods : [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  for (const method of requiredMethods) {
    if (supportedMethods.has(method)) {
      continue;
    }
    throw new Error(
      [
        `active gateway does not support required method "${method}" for "${params.attemptedMethod}".`,
        "Update the gateway or run without SecretRefs.",
      ].join(" "),
    );
  }
}

async function executeGatewayRequestWithScopes<T>(params: {
  opts: CallGatewayBaseOptions;
  scopes: OperatorScope[];
  url: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  timeoutMs: number;
  safeTimerTimeoutMs: number;
  connectionDetails: GatewayConnectionDetails;
}): Promise<T> {
  const { opts, scopes, url, token, password, tlsFingerprint, timeoutMs, safeTimerTimeoutMs } =
    params;
  // Yield to the event loop before starting the WebSocket connection.
  // On Windows with large dist bundles, heavy synchronous module loading
  // Can starve the event loop, preventing timely processing of the
  // Connect.challenge frame and causing handshake timeouts (#48736).
  await new Promise<void>((r) => setImmediate(r));
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let ignoreClose = false;
    const stop = (err?: Error, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(value as T);
      }
    };

    const client = gatewayCallDeps.createGatewayClient({
      clientDisplayName: resolveGatewayClientDisplayName(opts),
      clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
      clientVersion: opts.clientVersion ?? VERSION,
      deviceIdentity: resolveDeviceIdentityForGatewayCall(),
      instanceId: opts.instanceId ?? randomUUID(),
      maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
      minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
      mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
      onClose: (code, reason) => {
        if (settled || ignoreClose) {
          return;
        }
        ignoreClose = true;
        client.stop();
        stop(new Error(formatGatewayCloseError(code, reason, params.connectionDetails)));
      },
      onHelloOk: async (hello) => {
        try {
          ensureGatewaySupportsRequiredMethods({
            attemptedMethod: opts.method,
            methods: hello.features?.methods,
            requiredMethods: opts.requiredMethods,
          });
          const result = await client.request<T>(opts.method, opts.params, {
            expectFinal: opts.expectFinal,
            timeoutMs: opts.timeoutMs,
          });
          ignoreClose = true;
          stop(undefined, result);
          client.stop();
        } catch (error) {
          ignoreClose = true;
          client.stop();
          stop(error as Error);
        }
      },
      password,
      platform: opts.platform,
      role: "operator",
      scopes,
      tlsFingerprint,
      token,
      url,
    });

    const timer = setTimeout(() => {
      ignoreClose = true;
      client.stop();
      stop(new Error(formatGatewayTimeoutError(timeoutMs, params.connectionDetails)));
    }, safeTimerTimeoutMs);

    client.start();
  });
}

async function callGatewayWithScopes<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
  scopes: OperatorScope[],
): Promise<T> {
  const { timeoutMs, safeTimerTimeoutMs } = resolveGatewayCallTimeout(opts.timeoutMs);
  const context = resolveGatewayCallContext(opts);
  const resolvedCredentials = await resolveGatewayCredentials(context);
  ensureExplicitGatewayAuth({
    configPath: context.configPath,
    errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
    explicitAuth: context.explicitAuth,
    resolvedAuth: resolvedCredentials,
    urlOverride: context.urlOverride,
    urlOverrideSource: context.urlOverrideSource,
  });
  ensureRemoteModeUrlConfigured(context);
  const connectionDetails = buildGatewayConnectionDetails({
    config: context.config,
    url: context.urlOverride,
    urlSource: context.urlOverrideSource,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  });
  const { url } = connectionDetails;
  const tlsFingerprint = await resolveGatewayTlsFingerprint({ context, opts, url });
  const { token, password } = resolvedCredentials;
  return await executeGatewayRequestWithScopes<T>({
    connectionDetails,
    opts,
    password,
    safeTimerTimeoutMs,
    scopes,
    timeoutMs,
    tlsFingerprint,
    token,
    url,
  });
}

export async function callGatewayScoped<T = Record<string, unknown>>(
  opts: CallGatewayScopedOptions,
): Promise<T> {
  return await callGatewayWithScopes(opts, opts.scopes);
}

export async function callGatewayCli<T = Record<string, unknown>>(
  opts: CallGatewayCliOptions,
): Promise<T> {
  const scopes = Array.isArray(opts.scopes) ? opts.scopes : CLI_DEFAULT_OPERATOR_SCOPES;
  return await callGatewayWithScopes(opts, scopes);
}

export async function callGatewayLeastPrivilege<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
): Promise<T> {
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(opts.method);
  return await callGatewayWithScopes(opts, scopes);
}

export async function callGateway<T = Record<string, unknown>>(
  opts: CallGatewayOptions,
): Promise<T> {
  if (Array.isArray(opts.scopes)) {
    return await callGatewayWithScopes(opts, opts.scopes);
  }
  const callerMode = opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND;
  const callerName = opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;
  if (callerMode === GATEWAY_CLIENT_MODES.CLI || callerName === GATEWAY_CLIENT_NAMES.CLI) {
    return await callGatewayCli(opts);
  }
  return await callGatewayLeastPrivilege({
    ...opts,
    clientName: callerName,
    mode: callerMode,
  });
}

export function randomIdempotencyKey() {
  return randomUUID();
}
