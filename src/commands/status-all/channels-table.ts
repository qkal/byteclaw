import { groupChannelIssuesByChannel } from "./channel-issues.js";

interface ChannelTableRowInput {
  id: string;
  label: string;
  enabled: boolean;
  state: "ok" | "warn" | "off" | "setup";
  detail: string;
}

interface ChannelIssueLike {
  channel: string;
  message: string;
}

export const statusChannelsTableColumns = [
  { header: "Channel", key: "Channel", minWidth: 10 },
  { header: "Enabled", key: "Enabled", minWidth: 7 },
  { header: "State", key: "State", minWidth: 8 },
  { flex: true, header: "Detail", key: "Detail", minWidth: 24 },
] as const;

export function buildStatusChannelsTableRows(params: {
  rows: readonly ChannelTableRowInput[];
  channelIssues: readonly ChannelIssueLike[];
  ok: (text: string) => string;
  warn: (text: string) => string;
  muted: (text: string) => string;
  accentDim: (text: string) => string;
  formatIssueMessage?: (message: string) => string;
}) {
  const channelIssuesByChannel = groupChannelIssuesByChannel(params.channelIssues);
  const formatIssueMessage = params.formatIssueMessage ?? ((message: string) => message);
  return params.rows.map((row) => {
    const issues = channelIssuesByChannel.get(row.id) ?? [];
    const effectiveState = row.state === "off" ? "off" : (issues.length > 0 ? "warn" : row.state);
    const issueSuffix =
      issues.length > 0
        ? ` · ${params.warn(`gateway: ${formatIssueMessage(issues[0]?.message ?? "issue")}`)}`
        : "";
    return {
      Channel: row.label,
      Detail: `${row.detail}${issueSuffix}`,
      Enabled: row.enabled ? params.ok("ON") : params.muted("OFF"),
      State:
        effectiveState === "ok"
          ? params.ok("OK")
          : effectiveState === "warn"
            ? params.warn("WARN")
            : effectiveState === "off"
              ? params.muted("OFF")
              : params.accentDim("SETUP"),
    };
  });
}
