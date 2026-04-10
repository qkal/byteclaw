import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { renderTable } from "../../terminal/table.js";
import type { PendingRequest } from "./types.js";

export function renderPendingPairingRequestsTable(params: {
  pending: PendingRequest[];
  now: number;
  tableWidth: number;
  theme: {
    heading: (text: string) => string;
    warn: (text: string) => string;
    muted: (text: string) => string;
  };
}) {
  const { pending, now, tableWidth, theme } = params;
  const rows = pending.map((r) => ({
    IP: r.remoteIp ?? "",
    Node: r.displayName?.trim() ? r.displayName.trim() : r.nodeId,
    Request: r.requestId,
    Requested:
      typeof r.ts === "number" ? formatTimeAgo(Math.max(0, now - r.ts)) : theme.muted("unknown"),
  }));
  return {
    heading: theme.heading("Pending"),
    table: renderTable({
      columns: [
        { header: "Request", key: "Request", minWidth: 8 },
        { flex: true, header: "Node", key: "Node", minWidth: 14 },
        { header: "IP", key: "IP", minWidth: 10 },
        { header: "Requested", key: "Requested", minWidth: 12 },
      ],
      rows,
      width: tableWidth,
    }).trimEnd(),
  };
}
