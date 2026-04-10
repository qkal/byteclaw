import { withProgress } from "../cli/progress.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildStatusAllReportData } from "./status-all/report-data.js";
import { buildStatusAllReportLines } from "./status-all/report-lines.js";
import { resolveStatusServiceSummaries } from "./status-runtime-shared.ts";
import { resolveNodeOnlyGatewayInfo } from "./status.node-mode.js";
import { collectStatusScanOverview } from "./status.scan-overview.ts";

export async function statusAllCommand(
  runtime: RuntimeEnv,
  opts?: { timeoutMs?: number },
): Promise<void> {
  await withProgress({ label: "Scanning status --all…", total: 11 }, async (progress) => {
    const overview = await collectStatusScanOverview({
      commandName: "status --all",
      labels: {
        checkingForUpdates: "Checking for updates…",
        checkingTailscale: "Checking Tailscale…",
        loadingConfig: "Loading config…",
        probingGateway: "Probing gateway…",
        queryingChannelStatus: "Querying gateway…",
        resolvingAgents: "Scanning agents…",
        summarizingChannels: "Summarizing channels…",
      },
      opts: {
        timeoutMs: opts?.timeoutMs,
      },
      progress,
      runtime,
      showSecrets: false,
      useGatewayCallOverridesForChannelsStatus: true,
    });
    progress.setLabel("Checking services…");
    const [daemon, nodeService] = await resolveStatusServiceSummaries();
    const nodeOnlyGateway = await resolveNodeOnlyGatewayInfo({
      daemon,
      node: nodeService,
    });
    progress.tick();
    const lines = await buildStatusAllReportLines({
      progress,
      ...(await buildStatusAllReportData({
        daemon,
        nodeOnlyGateway,
        nodeService,
        overview,
        progress,
        timeoutMs: opts?.timeoutMs,
      })),
    });

    progress.setLabel("Rendering…");
    runtime.log(lines.join("\n"));
    progress.tick();
  });
}
