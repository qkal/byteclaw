import { describe, expect, it } from "vitest";
import { classifyAcpToolApproval } from "./approval-classifier.js";

function classify(params: {
  title: string;
  rawInput?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  cwd?: string;
}) {
  return classifyAcpToolApproval({
    cwd: params.cwd ?? "/workspace",
    toolCall: {
      _meta: params.meta,
      rawInput: params.rawInput,
      title: params.title,
    },
  });
}

describe("classifyAcpToolApproval", () => {
  it("auto-approves scoped readonly reads", () => {
    expect(
      classify({
        rawInput: { path: "src/index.ts" },
        title: "read: src/index.ts",
      }),
    ).toEqual({
      approvalClass: "readonly_scoped",
      autoApprove: true,
      toolName: "read",
    });
  });

  it("does not auto-approve reads outside cwd", () => {
    expect(
      classify({
        rawInput: { path: "~/.ssh/id_rsa" },
        title: "read: ~/.ssh/id_rsa",
      }),
    ).toEqual({
      approvalClass: "other",
      autoApprove: false,
      toolName: "read",
    });
  });

  it("auto-approves readonly search tools", () => {
    expect(
      classify({
        rawInput: { name: "memory_search", query: "vectors" },
        title: "memory_search: vectors",
      }),
    ).toEqual({
      approvalClass: "readonly_search",
      autoApprove: true,
      toolName: "memory_search",
    });
  });

  it("classifies process as exec-capable even for readonly-like actions", () => {
    expect(
      classify({
        rawInput: { action: "list", name: "process" },
        title: "process: list",
      }),
    ).toEqual({
      approvalClass: "exec_capable",
      autoApprove: false,
      toolName: "process",
    });
  });

  it.each([
    {
      expectedClass: "control_plane",
      expectedToolName: "cron",
      rawInput: { action: "status", name: "cron" },
      title: "cron: status",
    },
    {
      expectedClass: "exec_capable",
      expectedToolName: "nodes",
      rawInput: { action: "list", name: "nodes" },
      title: "nodes: list",
    },
    {
      expectedClass: "interactive",
      expectedToolName: "whatsapp_login",
      rawInput: { name: "whatsapp_login" },
      title: "whatsapp_login: start",
    },
  ] as const)(
    "classifies shared owner-only ACP backstops for $expectedToolName",
    ({ title, rawInput, expectedToolName, expectedClass }) => {
      expect(
        classify({
          rawInput,
          title,
        }),
      ).toEqual({
        approvalClass: expectedClass,
        autoApprove: false,
        toolName: expectedToolName,
      });
    },
  );

  it("classifies gateway as control-plane", () => {
    expect(
      classify({
        rawInput: { action: "status", name: "gateway" },
        title: "gateway: status",
      }),
    ).toEqual({
      approvalClass: "control_plane",
      autoApprove: false,
      toolName: "gateway",
    });
  });

  it("classifies mutating messaging tools as mutating", () => {
    expect(
      classify({
        rawInput: { action: "send", message: "hi", name: "message" },
        title: "message: send",
      }),
    ).toEqual({
      approvalClass: "mutating",
      autoApprove: false,
      toolName: "message",
    });
  });

  it("fails closed on spoofed metadata and title mismatches", () => {
    expect(
      classify({
        rawInput: { name: "search", query: "uname -a" },
        title: "exec: uname -a",
      }),
    ).toEqual({
      approvalClass: "unknown",
      autoApprove: false,
      toolName: undefined,
    });
  });
});
