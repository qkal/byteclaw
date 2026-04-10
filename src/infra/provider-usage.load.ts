import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { resolveProviderUsageSnapshotWithPlugin } from "../plugins/provider-runtime.js";
import { resolveFetch } from "./fetch.js";
import { type ProviderAuth, resolveProviderAuths } from "./provider-usage.auth.js";
import {
  DEFAULT_TIMEOUT_MS,
  PROVIDER_LABELS,
  ignoredErrors,
  usageProviders,
  withTimeout,
} from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "./provider-usage.types.js";

async function fetchProviderUsageSnapshotFallback(params: {
  auth: ProviderAuth;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  void params.timeoutMs;
  void params.fetchFn;
  return {
    displayName: PROVIDER_LABELS[params.auth.provider] ?? params.auth.provider,
    error: "Unsupported provider",
    provider: params.auth.provider,
    windows: [],
  };
}

interface UsageSummaryOptions {
  now?: number;
  timeoutMs?: number;
  providers?: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

async function fetchProviderUsageSnapshot(params: {
  auth: ProviderAuth;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  const pluginSnapshot = await resolveProviderUsageSnapshotWithPlugin({
    config: params.config,
    context: {
      accountId: params.auth.accountId,
      agentDir: params.agentDir,
      config: params.config,
      env: params.env,
      fetchFn: params.fetchFn,
      provider: params.auth.provider,
      timeoutMs: params.timeoutMs,
      token: params.auth.token,
      workspaceDir: params.workspaceDir,
    },
    env: params.env,
    provider: params.auth.provider,
    workspaceDir: params.workspaceDir,
  });
  if (pluginSnapshot) {
    return pluginSnapshot;
  }
  return await fetchProviderUsageSnapshotFallback({
    auth: params.auth,
    fetchFn: params.fetchFn,
    timeoutMs: params.timeoutMs,
  });
}

export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const config = opts.config ?? loadConfig();
  const env = opts.env ?? process.env;
  const fetchFn = resolveFetch(opts.fetch);
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }

  const auths = await resolveProviderAuths({
    agentDir: opts.agentDir,
    auth: opts.auth,
    config,
    env,
    providers: opts.providers ?? usageProviders,
  });
  if (auths.length === 0) {
    return { providers: [], updatedAt: now };
  }

  const tasks = auths.map((auth) =>
    withTimeout(
      fetchProviderUsageSnapshot({
        agentDir: opts.agentDir,
        auth,
        config,
        env,
        fetchFn,
        timeoutMs,
        workspaceDir: opts.workspaceDir,
      }),
      timeoutMs + 1000,
      {
        displayName: PROVIDER_LABELS[auth.provider],
        error: "Timeout",
        provider: auth.provider,
        windows: [],
      },
    ),
  );

  const snapshots = await Promise.all(tasks);
  const providers = snapshots.filter((entry) => {
    if (entry.windows.length > 0) {
      return true;
    }
    if (!entry.error) {
      return true;
    }
    return !ignoredErrors.has(entry.error);
  });

  return { providers, updatedAt: now };
}
