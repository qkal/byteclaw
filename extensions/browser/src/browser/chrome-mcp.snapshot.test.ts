import { describe, expect, it } from "vitest";
import {
  buildAiSnapshotFromChromeMcpSnapshot,
  flattenChromeMcpSnapshotToAriaNodes,
} from "./chrome-mcp.snapshot.js";

const snapshot = {
  children: [
    {
      id: "btn-1",
      name: "Continue",
      role: "button",
    },
    {
      id: "txt-1",
      name: "Email",
      role: "textbox",
      value: "peter@example.com",
    },
  ],
  id: "root",
  name: "Example",
  role: "document",
};

describe("chrome MCP snapshot conversion", () => {
  it("flattens structured snapshots into aria-style nodes", () => {
    const nodes = flattenChromeMcpSnapshotToAriaNodes(snapshot, 10);
    expect(nodes).toEqual([
      {
        depth: 0,
        description: undefined,
        name: "Example",
        ref: "root",
        role: "document",
        value: undefined,
      },
      {
        depth: 1,
        description: undefined,
        name: "Continue",
        ref: "btn-1",
        role: "button",
        value: undefined,
      },
      {
        depth: 1,
        description: undefined,
        name: "Email",
        ref: "txt-1",
        role: "textbox",
        value: "peter@example.com",
      },
    ]);
  });

  it("builds AI snapshots that preserve Chrome MCP uids as refs", () => {
    const result = buildAiSnapshotFromChromeMcpSnapshot({ root: snapshot });

    expect(result.snapshot).toContain('- button "Continue" [ref=btn-1]');
    expect(result.snapshot).toContain('- textbox "Email" [ref=txt-1] value="peter@example.com"');
    expect(result.refs).toEqual({
      "btn-1": { name: "Continue", role: "button" },
      "txt-1": { name: "Email", role: "textbox" },
    });
    expect(result.stats.refs).toBe(2);
  });
});
