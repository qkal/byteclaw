import { describe, expect, it } from "vitest";
import { buildStatusCommandReportLines } from "./status.command-report.ts";

function createRenderTable() {
  return ({ columns, rows }: { columns: Record<string, unknown>[]; rows: unknown[] }) =>
    `table:${String(columns[0]?.header)}:${rows.length}`;
}

describe("buildStatusCommandReportLines", () => {
  it("builds the full command report with optional sections", async () => {
    const lines = await buildStatusCommandReportLines({
      channelsColumns: [{ header: "Channel", key: "Channel" }],
      channelsRows: [{ Channel: "telegram" }],
      footerLines: ["FAQ", "Next steps:"],
      heading: (text) => `# ${text}`,
      healthColumns: [{ header: "Item", key: "Item" }],
      healthRows: [{ Item: "Gateway" }],
      muted: (text) => `muted(${text})`,
      overviewRows: [{ Item: "OS", Value: "macOS" }],
      pairingRecoveryLines: ["pairing needed"],
      pluginCompatibilityLines: ["warn 1"],
      renderTable: createRenderTable(),
      securityAuditLines: ["audit line"],
      sessionsColumns: [{ header: "Key", key: "Key" }],
      sessionsRows: [{ Key: "main" }],
      showTaskMaintenanceHint: true,
      systemEventsRows: [{ Event: "queued" }],
      systemEventsTrailer: "muted(… +1 more)",
      taskMaintenanceHint: "maintenance hint",
      usageLines: ["usage line"],
      width: 120,
    });

    expect(lines).toEqual([
      "# OpenClaw status",
      "",
      "# Overview",
      "table:Item:1",
      "",
      "muted(maintenance hint)",
      "",
      "# Plugin compatibility",
      "warn 1",
      "",
      "pairing needed",
      "",
      "# Security audit",
      "audit line",
      "",
      "# Channels",
      "table:Channel:1",
      "",
      "# Sessions",
      "table:Key:1",
      "",
      "# System events",
      "table:Event:1",
      "muted(… +1 more)",
      "",
      "# Health",
      "table:Item:1",
      "",
      "# Usage",
      "usage line",
      "",
      "FAQ",
      "Next steps:",
    ]);
  });

  it("omits optional sections when inputs are absent", async () => {
    const lines = await buildStatusCommandReportLines({
      channelsColumns: [{ header: "Channel", key: "Channel" }],
      channelsRows: [{ Channel: "telegram" }],
      footerLines: ["FAQ"],
      heading: (text) => `# ${text}`,
      muted: (text) => text,
      overviewRows: [{ Item: "OS", Value: "macOS" }],
      pairingRecoveryLines: [],
      pluginCompatibilityLines: [],
      renderTable: createRenderTable(),
      securityAuditLines: ["audit line"],
      sessionsColumns: [{ header: "Key", key: "Key" }],
      sessionsRows: [{ Key: "main" }],
      showTaskMaintenanceHint: false,
      taskMaintenanceHint: "ignored",
      width: 120,
    });

    expect(lines).not.toContain("# Plugin compatibility");
    expect(lines).not.toContain("# System events");
    expect(lines).not.toContain("# Health");
    expect(lines).not.toContain("# Usage");
    expect(lines.at(-1)).toBe("FAQ");
  });
});
