import type { RenderTableOptions, TableColumn } from "../terminal/table.js";
import {
  buildStatusChannelsTableSection,
  buildStatusHealthSection,
  buildStatusOverviewSection,
  buildStatusSessionsSection,
  buildStatusSystemEventsSection,
  buildStatusUsageSection,
} from "./status-all/report-sections.js";
import { appendStatusReportSections } from "./status-all/text-report.js";

export async function buildStatusCommandReportLines(params: {
  heading: (text: string) => string;
  muted: (text: string) => string;
  renderTable: (input: RenderTableOptions) => string;
  width: number;
  overviewRows: { Item: string; Value: string }[];
  showTaskMaintenanceHint: boolean;
  taskMaintenanceHint: string;
  pluginCompatibilityLines: string[];
  pairingRecoveryLines: string[];
  securityAuditLines: string[];
  channelsColumns: readonly TableColumn[];
  channelsRows: Record<string, string>[];
  sessionsColumns: readonly TableColumn[];
  sessionsRows: Record<string, string>[];
  systemEventsRows?: Record<string, string>[];
  systemEventsTrailer?: string | null;
  healthColumns?: readonly TableColumn[];
  healthRows?: Record<string, string>[];
  usageLines?: string[];
  footerLines: string[];
}) {
  const lines: string[] = [];
  lines.push(params.heading("OpenClaw status"));

  appendStatusReportSections({
    heading: params.heading,
    lines,
    sections: [
      {
        ...buildStatusOverviewSection({
          renderTable: params.renderTable,
          rows: params.overviewRows,
          width: params.width,
        }),
      },
      {
        body: params.showTaskMaintenanceHint ? ["", params.muted(params.taskMaintenanceHint)] : [],
        kind: "raw",
        skipIfEmpty: true,
      },
      {
        body: params.pluginCompatibilityLines,
        kind: "lines",
        skipIfEmpty: true,
        title: "Plugin compatibility",
      },
      {
        body: params.pairingRecoveryLines.length > 0 ? ["", ...params.pairingRecoveryLines] : [],
        kind: "raw",
        skipIfEmpty: true,
      },
      {
        body: params.securityAuditLines,
        kind: "lines",
        title: "Security audit",
      },
      {
        ...buildStatusChannelsTableSection({
          columns: params.channelsColumns,
          renderTable: params.renderTable,
          rows: params.channelsRows,
          width: params.width,
        }),
      },
      {
        ...buildStatusSessionsSection({
          columns: params.sessionsColumns,
          renderTable: params.renderTable,
          rows: params.sessionsRows,
          width: params.width,
        }),
      },
      {
        ...buildStatusSystemEventsSection({
          renderTable: params.renderTable,
          rows: params.systemEventsRows,
          trailer: params.systemEventsTrailer,
          width: params.width,
        }),
      },
      {
        ...buildStatusHealthSection({
          columns: params.healthColumns,
          renderTable: params.renderTable,
          rows: params.healthRows,
          width: params.width,
        }),
      },
      {
        ...buildStatusUsageSection({ usageLines: params.usageLines }),
      },
      {
        body: ["", ...params.footerLines],
        kind: "raw",
      },
    ],
  });
  return lines;
}
