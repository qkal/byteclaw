import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSubagentsSendContext } from "./commands-subagents.test-helpers.js";
import { handleSubagentsSendAction } from "./commands-subagents/action-send.js";

const sendControlledSubagentMessageMock = vi.hoisted(() => vi.fn());
const steerControlledSubagentRunMock = vi.hoisted(() => vi.fn());

vi.mock("./commands-subagents-control.runtime.js", () => ({
  sendControlledSubagentMessage: sendControlledSubagentMessageMock,
  steerControlledSubagentRun: steerControlledSubagentRunMock,
}));

const buildContext = () =>
  buildSubagentsSendContext({
    handledPrefix: "/steer",
    restTokens: ["1", "check", "timer.ts", "instead"],
  });

describe("subagents steer action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats accepted steer replies", async () => {
    steerControlledSubagentRunMock.mockResolvedValue({
      runId: "run-steer-1",
      status: "accepted",
    });
    const result = await handleSubagentsSendAction(buildContext(), true);
    expect(result).toEqual({
      reply: { text: "steered do thing (run run-stee)." },
      shouldContinue: false,
    });
  });

  it("formats steer dispatch errors", async () => {
    steerControlledSubagentRunMock.mockResolvedValue({
      error: "dispatch failed",
      status: "error",
    });
    const result = await handleSubagentsSendAction(buildContext(), true);
    expect(result).toEqual({
      reply: { text: "send failed: dispatch failed" },
      shouldContinue: false,
    });
  });
});
