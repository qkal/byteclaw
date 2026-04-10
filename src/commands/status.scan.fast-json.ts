import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import type { RuntimeEnv } from "../runtime.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import {
  resolveDefaultMemoryStorePath,
  resolveStatusMemoryStatusSnapshot,
} from "./status.scan-memory.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

interface StatusJsonScanPolicy {
  commandName: string;
  allowMissingConfigFastPath?: boolean;
  resolveHasConfiguredChannels: (
    cfg: Parameters<typeof hasPotentialConfiguredChannels>[0],
  ) => boolean;
  resolveMemory: Parameters<typeof executeStatusScanFromOverview>[0]["resolveMemory"];
}

export async function scanStatusJsonWithPolicy(
  opts: {
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
  policy: StatusJsonScanPolicy,
): Promise<StatusScanResult> {
  const overview = await collectStatusScanOverview({
    allowMissingConfigFastPath: policy.allowMissingConfigFastPath,
    commandName: policy.commandName,
    includeChannelsData: false,
    opts,
    resolveHasConfiguredChannels: policy.resolveHasConfiguredChannels,
    runtime,
    showSecrets: false,
  });
  if (overview.hasConfiguredChannels) {
    await ensureCliPluginRegistryLoaded({
      routeLogsToStderr: true,
      scope: "configured-channels",
    });
  }

  return await executeStatusScanFromOverview({
    channelIssues: [],
    channels: { details: [], rows: [] },
    overview,
    pluginCompatibility: [],
    resolveMemory: policy.resolveMemory,
    runtime,
  });
}

export async function scanStatusJsonFast(
  opts: {
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  return await scanStatusJsonWithPolicy(opts, runtime, {
    allowMissingConfigFastPath: true,
    commandName: "status --json",
    resolveHasConfiguredChannels: (cfg) =>
      hasPotentialConfiguredChannels(cfg, process.env, {
        includePersistedAuthState: false,
      }),
    resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
      opts.all
        ? await resolveStatusMemoryStatusSnapshot({
            agentStatus,
            cfg,
            memoryPlugin,
            requireDefaultStore: resolveDefaultMemoryStorePath,
          })
        : null,
  });
}
