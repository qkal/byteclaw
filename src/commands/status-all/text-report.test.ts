import { describe, expect, it } from "vitest";
import { appendStatusReportSections } from "./text-report.js";

describe("appendStatusReportSections", () => {
  it("renders mixed raw, line, and table sections in order", () => {
    const lines: string[] = ["# Start"];

    appendStatusReportSections({
      heading: (text) => `# ${text}`,
      lines,
      sections: [
        {
          body: ["", "raw note"],
          kind: "raw",
        },
        {
          body: ["overview body"],
          kind: "lines",
          title: "Overview",
        },
        {
          columns: [{ key: "Item", header: "Item" }],
          kind: "table",
          renderTable: ({ rows }) => `table:${rows.length}`,
          rows: [{ Item: "Gateway" }],
          title: "Health",
          trailer: "trailer",
          width: 120,
        },
        {
          body: [],
          kind: "lines",
          skipIfEmpty: true,
          title: "Skipped",
        },
      ],
    });

    expect(lines).toEqual([
      "# Start",
      "",
      "raw note",
      "",
      "# Overview",
      "overview body",
      "",
      "# Health",
      "table:1",
      "trailer",
    ]);
  });
});
