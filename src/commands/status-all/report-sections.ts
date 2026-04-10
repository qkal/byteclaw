import type { RenderTableOptions, TableColumn } from "../../terminal/table.js";
import { buildStatusChannelsTableRows, statusChannelsTableColumns } from "./channels-table.js";
import {
  buildStatusAgentTableRows,
  buildStatusChannelDetailSections,
  statusAgentsTableColumns,
  statusOverviewTableColumns,
} from "./report-tables.js";
import type { StatusReportSection } from "./text-report.js";

type TableRenderer = (input: RenderTableOptions) => string;

export function buildStatusOverviewSection(params: {
  width: number;
  renderTable: TableRenderer;
  rows: { Item: string; Value: string }[];
}): StatusReportSection {
  return {
    columns: [...statusOverviewTableColumns],
    kind: "table",
    renderTable: params.renderTable,
    rows: params.rows,
    title: "Overview",
    width: params.width,
  };
}

export function buildStatusChannelsSection(params: {
  width: number;
  renderTable: TableRenderer;
  rows: {
    id: string;
    label: string;
    enabled: boolean;
    state: "ok" | "warn" | "off" | "setup";
    detail: string;
  }[];
  channelIssues: {
    channel: string;
    message: string;
  }[];
  ok: (text: string) => string;
  warn: (text: string) => string;
  muted: (text: string) => string;
  accentDim: (text: string) => string;
  formatIssueMessage?: (message: string) => string;
}): StatusReportSection {
  return {
    columns: statusChannelsTableColumns.map((column) =>
      column.key === "Detail" ? { ...column, minWidth: 28 } : column,
    ),
    kind: "table",
    renderTable: params.renderTable,
    rows: buildStatusChannelsTableRows({
      accentDim: params.accentDim,
      channelIssues: params.channelIssues,
      formatIssueMessage: params.formatIssueMessage,
      muted: params.muted,
      ok: params.ok,
      rows: params.rows,
      warn: params.warn,
    }),
    title: "Channels",
    width: params.width,
  } as StatusReportSection;
}

export function buildStatusChannelsTableSection(params: {
  width: number;
  renderTable: TableRenderer;
  columns: readonly TableColumn[];
  rows: Record<string, string>[];
}): StatusReportSection {
  return {
    columns: [...params.columns],
    kind: "table",
    renderTable: params.renderTable,
    rows: params.rows,
    title: "Channels",
    width: params.width,
  };
}

export function buildStatusChannelDetailsSections(params: {
  details: {
    title: string;
    columns: string[];
    rows: Record<string, string>[];
  }[];
  width: number;
  renderTable: TableRenderer;
  ok: (text: string) => string;
  warn: (text: string) => string;
}): StatusReportSection[] {
  return buildStatusChannelDetailSections({
    details: params.details,
    ok: params.ok,
    renderTable: params.renderTable,
    warn: params.warn,
    width: params.width,
  });
}

export function buildStatusAgentsSection(params: {
  width: number;
  renderTable: TableRenderer;
  agentStatus: {
    agents: {
      id: string;
      name?: string | null;
      bootstrapPending?: boolean | null;
      sessionsCount: number;
      lastActiveAgeMs?: number | null;
      sessionsPath: string;
    }[];
  };
  ok: (text: string) => string;
  warn: (text: string) => string;
}): StatusReportSection {
  return {
    columns: [...statusAgentsTableColumns],
    kind: "table",
    renderTable: params.renderTable,
    rows: buildStatusAgentTableRows({
      agentStatus: params.agentStatus,
      ok: params.ok,
      warn: params.warn,
    }),
    title: "Agents",
    width: params.width,
  };
}

export function buildStatusSessionsSection(params: {
  width: number;
  renderTable: TableRenderer;
  columns: readonly TableColumn[];
  rows: Record<string, string>[];
}): StatusReportSection {
  return {
    columns: [...params.columns],
    kind: "table",
    renderTable: params.renderTable,
    rows: params.rows,
    title: "Sessions",
    width: params.width,
  };
}

export function buildStatusSystemEventsSection(params: {
  width: number;
  renderTable: TableRenderer;
  rows?: Record<string, string>[];
  trailer?: string | null;
}): StatusReportSection {
  return {
    columns: [{ flex: true, header: "Event", key: "Event", minWidth: 24 }],
    kind: "table",
    renderTable: params.renderTable,
    rows: params.rows ?? [],
    skipIfEmpty: true,
    title: "System events",
    trailer: params.trailer,
    width: params.width,
  };
}

export function buildStatusHealthSection(params: {
  width: number;
  renderTable: TableRenderer;
  columns?: readonly TableColumn[];
  rows?: Record<string, string>[];
}): StatusReportSection {
  return {
    columns: [...(params.columns ?? [])],
    kind: "table",
    renderTable: params.renderTable,
    rows: params.rows ?? [],
    skipIfEmpty: true,
    title: "Health",
    width: params.width,
  };
}

export function buildStatusUsageSection(params: { usageLines?: string[] }): StatusReportSection {
  return {
    body: params.usageLines ?? [],
    kind: "lines",
    skipIfEmpty: true,
    title: "Usage",
  };
}
