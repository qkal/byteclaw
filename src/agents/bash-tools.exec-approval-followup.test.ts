import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

import { sendMessage } from "../infra/outbound/message.js";
import {
  buildExecApprovalFollowupPrompt,
  sendExecApprovalFollowup,
} from "./bash-tools.exec-approval-followup.js";
import { callGatewayTool } from "./tools/gateway.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("exec approval followup", () => {
  it("uses an explicit denial prompt when the command did not run", () => {
    const prompt = buildExecApprovalFollowupPrompt(
      "Exec denied (gateway id=req-1, user-denied): uname -a",
    );

    expect(prompt).toContain("did not run");
    expect(prompt).toContain("Do not mention, summarize, or reuse output");
    expect(prompt).not.toContain("already approved has completed");
  });

  it("tells the agent to continue the task before replying when the command succeeds", () => {
    const prompt = buildExecApprovalFollowupPrompt("Exec finished (gateway id=req-1, code 0)\nok");

    expect(prompt).toContain("continue from this result before replying to the user");
    expect(prompt).toContain("Continue the task if needed, then reply to the user");
  });

  it("keeps followups internal when no external route is available", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-1",
      resultText: "Exec completed: echo ok",
      sessionKey: "agent:main:main",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      expect.any(Object),
      expect.objectContaining({
        channel: undefined,
        deliver: false,
        sessionKey: "agent:main:main",
        to: undefined,
      }),
      { expectFinal: true },
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      accountId: "default",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:C123",
      threadId: "1712419200.1234",
      to: "channel:C123",
    },
    {
      accountId: "default",
      channel: "discord",
      sessionKey: "agent:main:discord:channel:123",
      threadId: "456",
      to: "123",
    },
    {
      accountId: "default",
      channel: "telegram",
      sessionKey: "agent:main:telegram:-100123",
      threadId: "789",
      to: "-100123",
    },
  ])("uses agent continuation for $channel followups when a session exists", async (target) => {
    await sendExecApprovalFollowup({
      approvalId: `req-${target.channel}`,
      resultText: "slack exec approval smoke",
      sessionKey: target.sessionKey,
      turnSourceAccountId: target.accountId,
      turnSourceChannel: target.channel,
      turnSourceThreadId: target.threadId,
      turnSourceTo: target.to,
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      expect.any(Object),
      expect.objectContaining({
        accountId: target.accountId,
        bestEffortDeliver: true,
        channel: target.channel,
        deliver: true,
        idempotencyKey: `exec-approval-followup:req-${target.channel}`,
        sessionKey: target.sessionKey,
        threadId: target.threadId,
        to: target.to,
      }),
      { expectFinal: true },
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to sanitized direct external delivery only when no session exists", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-no-session",
      resultText: "Exec finished (gateway id=req-no-session, session=sess_1, code 0)\nall good",
      turnSourceAccountId: "default",
      turnSourceChannel: "discord",
      turnSourceThreadId: "456",
      turnSourceTo: "123",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        channel: "discord",
        content: "all good",
        idempotencyKey: "exec-approval-followup:req-no-session",
        threadId: "456",
        to: "123",
      }),
    );
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("falls back to sanitized direct delivery when session resume fails", async () => {
    vi.mocked(callGatewayTool).mockRejectedValueOnce(new Error("session missing"));

    await sendExecApprovalFollowup({
      approvalId: "req-session-resume-failed",
      resultText:
        "Exec finished (gateway id=req-session-resume-failed, session=sess_1, code 0)\nall good",
      sessionKey: "agent:main:discord:channel:123",
      turnSourceAccountId: "default",
      turnSourceChannel: "discord",
      turnSourceThreadId: "456",
      turnSourceTo: "123",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Automatic session resume failed, so sending the status directly.\n\nall good",
        idempotencyKey: "exec-approval-followup:req-session-resume-failed",
      }),
    );
  });

  it("uses a generic summary when a no-session completion has no user-visible output", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-no-session-empty",
      resultText: "Exec finished (gateway id=req-no-session-empty, session=sess_2, code 0)",
      turnSourceAccountId: "default",
      turnSourceChannel: "discord",
      turnSourceThreadId: "456",
      turnSourceTo: "123",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Background command finished.",
        idempotencyKey: "exec-approval-followup:req-no-session-empty",
      }),
    );
  });

  it("uses safe denied copy when session resume fails", async () => {
    vi.mocked(callGatewayTool).mockRejectedValueOnce(new Error("session missing"));

    await sendExecApprovalFollowup({
      approvalId: "req-denied-resume-failed",
      resultText: "Exec denied (gateway id=req-denied-resume-failed, approval-timeout): uname -a",
      sessionKey: "agent:main:telegram:-100123",
      turnSourceAccountId: "default",
      turnSourceChannel: "telegram",
      turnSourceThreadId: "789",
      turnSourceTo: "-100123",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Automatic session resume failed, so sending the status directly.\n\nCommand did not run: approval timed out.",
        idempotencyKey: "exec-approval-followup:req-denied-resume-failed",
      }),
    );
  });

  it("suppresses denied followups for subagent sessions", async () => {
    await expect(
      sendExecApprovalFollowup({
        approvalId: "req-denied-subagent",
        resultText: "Exec denied (gateway id=req-denied-subagent, approval-timeout): uname -a",
        sessionKey: "agent:main:subagent:test",
        turnSourceAccountId: "default",
        turnSourceChannel: "telegram",
        turnSourceTo: "123",
      }),
    ).resolves.toBe(false);

    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    "Exec denied (gateway id=req-denied-nosession, approval-timeout): uname -a",
    "exec denied (gateway id=req-denied-nosession, approval-timeout): uname -a",
  ])("does not mirror raw denied followups without a session: %s", async (resultText) => {
    await expect(
      sendExecApprovalFollowup({
        approvalId: "req-denied-nosession",
        resultText,
        turnSourceAccountId: "default",
        turnSourceChannel: "telegram",
        turnSourceTo: "123",
      }),
    ).resolves.toBe(false);

    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("throws when neither a session nor a deliverable route is available", async () => {
    await expect(
      sendExecApprovalFollowup({
        approvalId: "req-missing",
        resultText: "Exec completed: echo ok",
        turnSourceChannel: "slack",
      }),
    ).rejects.toThrow("Session key or deliverable origin route is required");
  });
});
