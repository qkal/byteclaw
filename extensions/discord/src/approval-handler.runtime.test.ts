import { describe, expect, it } from "vitest";
import { discordApprovalNativeRuntime } from "./approval-handler.runtime.js";

describe("discordApprovalNativeRuntime", () => {
  it("routes origin approval updates to the Discord thread channel when threadId is present", async () => {
    const prepared = await discordApprovalNativeRuntime.transport.prepareTarget({
      accountId: "main",
      approvalKind: "exec",
      cfg: {} as never,
      context: {
        config: {} as never,
        token: "discord-token",
      },
      pendingPayload: {} as never,
      plannedTarget: {
        reason: "preferred",
        surface: "origin",
        target: {
          threadId: "777888999",
          to: "123456789",
        },
      },
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "hostname",
        },
      },
      view: {} as never,
    });

    expect(prepared).toEqual({
      dedupeKey: "777888999",
      target: {
        discordChannelId: "777888999",
      },
    });
  });
});
