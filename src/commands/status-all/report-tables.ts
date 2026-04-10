import type { RenderTableOptions } from "../../terminal/table.js";
import { formatTimeAgo } from "./format.js";
import type { StatusReportSection } from "./text-report.js";

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

interface ChannelDetailLike {
  title: string;
  columns: string[];
  rows: Record<string, string>[];
}

export const statusOverviewTableColumns = [
  { header: "Item", key: "Item", minWidth: 10 },
  { flex: true, header: "Value", key: "Value", minWidth: 24 },
] as const;

export const statusAgentsTableColumns = [
  { header: "Agent", key: "Agent", minWidth: 12 },
  { header: "Bootstrap file", key: "BootstrapFile", minWidth: 14 },
  { align: "right", header: "Sessions", key: "Sessions", minWidth: 8 },
  { header: "Active", key: "Active", minWidth: 10 },
  { flex: true, header: "Store", key: "Store", minWidth: 34 },
] as const;

export function buildStatusAgentTableRows(params: {
  agentStatus: AgentStatusLike;
  ok: (text: string) => string;
  warn: (text: string) => string;
}) {
  return params.agentStatus.agents.map((agent) => ({
    Active: agent.lastActiveAgeMs != null ? formatTimeAgo(agent.lastActiveAgeMs) : "unknown",
    Agent: agent.name?.trim() ? `${agent.id} (${agent.name.trim()})` : agent.id,
    BootstrapFile:
      agent.bootstrapPending === true
        ? params.warn("PRESENT")
        : (agent.bootstrapPending === false
          ? params.ok("ABSENT")
          : "unknown"),
    Sessions: String(agent.sessionsCount),
    Store: agent.sessionsPath,
  }));
}

export function buildStatusChannelDetailSections(params: {
  details: ChannelDetailLike[];
  width: number;
  renderTable: (input: RenderTableOptions) => string;
  ok: (text: string) => string;
  warn: (text: string) => string;
}): StatusReportSection[] {
  return params.details.map((detail) => ({
    columns: detail.columns.map((column) => ({
      flex: column === "Notes",
      header: column,
      key: column,
      minWidth: column === "Notes" ? 28 : 10,
    })),
    kind: "table" as const,
    renderTable: params.renderTable,
    rows: detail.rows.map((row) => ({
      ...row,
      ...(row.Status === "OK"
        ? { Status: params.ok("OK") }
        : (row.Status === "WARN"
          ? { Status: params.warn("WARN") }
          : {})),
    })),
    title: detail.title,
    width: params.width,
  }));
}
