import { describe, expect, it, vi } from "vitest";
import { telegramApprovalNativeRuntime } from "./approval-handler.runtime.js";

interface TelegramPayload {
  text: string;
  buttons?: Array<{ text: string }>[];
}

describe("telegramApprovalNativeRuntime", () => {
  it("renders only the allowed pending buttons", async () => {
    const payload = (await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      accountId: "default",
      approvalKind: "exec",
      cfg: {} as never,
      context: {
        token: "tg-token",
      },
      nowMs: 0,
      request: {
        createdAtMs: 0,
        expiresAtMs: 60_000,
        id: "req-1",
        request: {
          command: "echo hi",
        },
      },
      view: {
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve req-1 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve req-1 deny",
            style: "danger",
          },
        ],
        approvalId: "req-1",
        approvalKind: "exec",
        commandText: "echo hi",
      } as never,
    })) as TelegramPayload;

    expect(payload.text).toContain("/approve req-1 allow-once");
    expect(payload.text).not.toContain("allow-always");
    expect(payload.buttons?.[0]?.map((button) => button.text)).toEqual(["Allow Once", "Deny"]);
  });

  it("passes topic thread ids to typing and message delivery", async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({
      chatId: "-1003841603622",
      messageId: "m1",
    });

    const entry = await telegramApprovalNativeRuntime.transport.deliverPending({
      accountId: "default",
      approvalKind: "exec",
      cfg: {} as never,
      context: {
        deps: {
          sendMessage,
          sendTyping,
        },
        token: "tg-token",
      },
      pendingPayload: {
        buttons: [],
        text: "pending",
      },
      plannedTarget: {
        reason: "preferred",
        surface: "origin",
        target: {
          threadId: 928,
          to: "-1003841603622",
        },
      },
      preparedTarget: {
        chatId: "-1003841603622",
        messageThreadId: 928,
      },
      request: {
        createdAtMs: 0,
        expiresAtMs: 60_000,
        id: "req-1",
        request: {
          command: "echo hi",
        },
      },
      view: {
        actions: [],
        approvalId: "req-1",
        approvalKind: "exec",
        commandText: "echo hi",
      } as never,
    });

    expect(sendTyping).toHaveBeenCalledWith(
      "-1003841603622",
      expect.objectContaining({
        accountId: "default",
        messageThreadId: 928,
        token: "tg-token",
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "-1003841603622",
      "pending",
      expect.objectContaining({
        accountId: "default",
        buttons: [],
        messageThreadId: 928,
        token: "tg-token",
      }),
    );
    expect(entry).toEqual({
      chatId: "-1003841603622",
      messageId: "m1",
    });
  });
});
