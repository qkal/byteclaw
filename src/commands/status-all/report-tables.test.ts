import { describe, expect, it } from "vitest";
import {
  buildStatusAgentTableRows,
  buildStatusChannelDetailSections,
  statusAgentsTableColumns,
  statusOverviewTableColumns,
} from "./report-tables.js";

describe("status-all report tables", () => {
  it("builds agent rows with bootstrap semantics", () => {
    expect(
      buildStatusAgentTableRows({
        agentStatus: {
          agents: [
            {
              bootstrapPending: true,
              id: "main",
              lastActiveAgeMs: 12_000,
              name: "Primary",
              sessionsCount: 2,
              sessionsPath: "/tmp/main.json",
            },
            {
              bootstrapPending: false,
              id: "ops",
              lastActiveAgeMs: null,
              sessionsCount: 0,
              sessionsPath: "/tmp/ops.json",
            },
          ],
        },
        ok: (value) => `ok(${value})`,
        warn: (value) => `warn(${value})`,
      }),
    ).toEqual([
      {
        Active: "just now",
        Agent: "main (Primary)",
        BootstrapFile: "warn(PRESENT)",
        Sessions: "2",
        Store: "/tmp/main.json",
      },
      {
        Active: "unknown",
        Agent: "ops",
        BootstrapFile: "ok(ABSENT)",
        Sessions: "0",
        Store: "/tmp/ops.json",
      },
    ]);
  });

  it("builds colored detail table sections", () => {
    const [section] = buildStatusChannelDetailSections({
      details: [
        {
          columns: ["Channel", "Status", "Notes"],
          rows: [{ Channel: "telegram", Status: "WARN", Notes: "setup" }],
          title: "Channel detail",
        },
      ],
      ok: (value) => `ok(${value})`,
      renderTable: ({ rows }) => `rows:${rows.length}`,
      warn: (value) => `warn(${value})`,
      width: 120,
    });

    expect(section).toEqual({
      columns: [
        { flex: false, header: "Channel", key: "Channel", minWidth: 10 },
        { flex: false, header: "Status", key: "Status", minWidth: 10 },
        { flex: true, header: "Notes", key: "Notes", minWidth: 28 },
      ],
      kind: "table",
      renderTable: expect.any(Function),
      rows: [{ Channel: "telegram", Notes: "setup", Status: "warn(WARN)" }],
      title: "Channel detail",
      width: 120,
    });
  });

  it("exports stable shared columns", () => {
    expect(statusOverviewTableColumns).toEqual([
      { header: "Item", key: "Item", minWidth: 10 },
      { flex: true, header: "Value", key: "Value", minWidth: 24 },
    ]);
    expect(statusAgentsTableColumns).toEqual([
      { header: "Agent", key: "Agent", minWidth: 12 },
      { header: "Bootstrap file", key: "BootstrapFile", minWidth: 14 },
      { align: "right", header: "Sessions", key: "Sessions", minWidth: 8 },
      { header: "Active", key: "Active", minWidth: 10 },
      { flex: true, header: "Store", key: "Store", minWidth: 34 },
    ]);
  });
});
