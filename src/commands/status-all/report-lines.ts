import type { ProgressReporter } from "../../cli/progress.js";
import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { isRich, theme } from "../../terminal/theme.js";
import { appendStatusAllDiagnosis } from "./diagnosis.js";
import {
  buildStatusAgentsSection,
  buildStatusChannelDetailsSections,
  buildStatusChannelsSection,
  buildStatusOverviewSection,
} from "./report-sections.js";
import { appendStatusReportSections, appendStatusSectionHeading } from "./text-report.js";

interface OverviewRow { Item: string; Value: string }

interface ChannelsTable {
  rows: {
    id: string;
    label: string;
    enabled: boolean;
    state: "ok" | "warn" | "off" | "setup";
    detail: string;
  }[];
  details: {
    title: string;
    columns: string[];
    rows: Array<Record<string, string>>;
  }[];
}

interface ChannelIssueLike {
  channel: string;
  message: string;
}

interface AgentStatusLike {
  agents: {
    id: string;
    name?: string | null;
    bootstrapPending?: boolean | null;
    sessionsCount: number;
    lastActiveAgeMs?: number | null;
    sessionsPath: string;
  }[];
}

export async function buildStatusAllReportLines(params: {
  progress: ProgressReporter;
  overviewRows: OverviewRow[];
  channels: ChannelsTable;
  channelIssues: ChannelIssueLike[];
  agentStatus: AgentStatusLike;
  connectionDetailsForReport: string;
  diagnosis: Omit<
    Parameters<typeof appendStatusAllDiagnosis>[0],
    "lines" | "progress" | "muted" | "ok" | "warn" | "fail" | "connectionDetailsForReport"
  >;
}) {
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const ok = (text: string) => (rich ? theme.success(text) : text);
  const warn = (text: string) => (rich ? theme.warn(text) : text);
  const fail = (text: string) => (rich ? theme.error(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);

  const tableWidth = getTerminalTableWidth();

  const lines: string[] = [];
  lines.push(heading("OpenClaw status --all"));
  appendStatusReportSections({
    heading,
    lines,
    sections: [
      buildStatusOverviewSection({
        renderTable,
        rows: params.overviewRows,
        width: tableWidth,
      }),
      buildStatusChannelsSection({
        accentDim: theme.accentDim,
        channelIssues: params.channelIssues,
        formatIssueMessage: (message) => String(message).slice(0, 90),
        muted,
        ok,
        renderTable,
        rows: params.channels.rows,
        warn,
        width: tableWidth,
      }),
      ...buildStatusChannelDetailsSections({
        details: params.channels.details,
        ok,
        renderTable,
        warn,
        width: tableWidth,
      }),
      buildStatusAgentsSection({
        agentStatus: params.agentStatus,
        ok,
        renderTable,
        warn,
        width: tableWidth,
      }),
    ],
  });
  appendStatusSectionHeading({
    heading,
    lines,
    title: "Diagnosis (read-only)",
  });

  await appendStatusAllDiagnosis({
    connectionDetailsForReport: params.connectionDetailsForReport,
    fail,
    lines,
    muted,
    ok,
    progress: params.progress,
    warn,
    ...params.diagnosis,
  });

  return lines;
}
