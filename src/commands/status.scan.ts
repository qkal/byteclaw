import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { withProgress } from "../cli/progress.js";
import { buildPluginCompatibilityNotices } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import { resolveStatusMemoryStatusSnapshot } from "./status.scan-memory.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";
import { scanStatusJsonWithPolicy } from "./status.scan.fast-json.js";

export async function scanStatus(
  opts: {
    json?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  _runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  if (opts.json) {
    return await scanStatusJsonWithPolicy(
      {
        all: opts.all,
        timeoutMs: opts.timeoutMs,
      },
      _runtime,
      {
        commandName: "status --json",
        resolveHasConfiguredChannels: (cfg) => hasPotentialConfiguredChannels(cfg),
        resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
          await resolveStatusMemoryStatusSnapshot({
            agentStatus,
            cfg,
            memoryPlugin,
          }),
      },
    );
  }
  return await withProgress(
    {
      enabled: true,
      label: "Scanning status…",
      total: 10,
    },
    async (progress) => {
      const overview = await collectStatusScanOverview({
        commandName: "status",
        labels: {
          checkingForUpdates: "Checking for updates…",
          checkingTailscale: "Checking Tailscale…",
          loadingConfig: "Loading config…",
          probingGateway: "Probing gateway…",
          queryingChannelStatus: "Querying channel status…",
          resolvingAgents: "Resolving agents…",
          summarizingChannels: "Summarizing channels…",
        },
        opts,
        progress,
        showSecrets: process.env.OPENCLAW_SHOW_SECRETS?.trim() !== "0",
      });

      progress.setLabel("Checking plugins…");
      const pluginCompatibility = buildPluginCompatibilityNotices({ config: overview.cfg });
      progress.tick();

      progress.setLabel("Checking memory and sessions…");
      const result = await executeStatusScanFromOverview({
        channelIssues: overview.channelIssues,
        channels: overview.channels,
        overview,
        pluginCompatibility,
        resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
          await resolveStatusMemoryStatusSnapshot({
            agentStatus,
            cfg,
            memoryPlugin,
          }),
      });
      progress.tick();

      progress.setLabel("Rendering…");
      progress.tick();

      return result;
    },
  );
}
