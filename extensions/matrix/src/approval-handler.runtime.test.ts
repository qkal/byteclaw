import { describe, expect, it } from "vitest";
import { matrixApprovalNativeRuntime } from "./approval-handler.runtime.js";

describe("matrixApprovalNativeRuntime", () => {
  it("uses a longer code fence when resolved commands contain triple backticks", async () => {
    const result = await matrixApprovalNativeRuntime.presentation.buildResolvedResult({
      accountId: "default",
      cfg: {} as never,
      context: {
        client: {} as never,
      },
      entry: {} as never,
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
        },
      },
      resolved: {
        decision: "allow-once",
        id: "req-1",
        ts: 0,
      },
      view: {
        approvalId: "req-1",
        approvalKind: "exec",
        commandText: "echo ```danger```",
        decision: "allow-once",
      } as never,
    });

    expect(result).toEqual({
      kind: "update",
      payload: [
        "Exec approval: Allowed once",
        "",
        "Command",
        "````",
        "echo ```danger```",
        "````",
      ].join("\n"),
    });
  });
});
