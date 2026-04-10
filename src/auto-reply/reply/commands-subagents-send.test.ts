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
    handledPrefix: "/subagents",
    restTokens: ["1", "continue", "with", "follow-up", "details"],
  });

describe("subagents send action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats accepted send replies", async () => {
    sendControlledSubagentMessageMock.mockResolvedValue({
      replyText: "custom reply",
      runId: "run-followup-1",
      status: "accepted",
    });
    const result = await handleSubagentsSendAction(buildContext(), false);
    expect(result).toEqual({
      reply: { text: "custom reply" },
      shouldContinue: false,
    });
  });

  it("formats forbidden send replies", async () => {
    sendControlledSubagentMessageMock.mockResolvedValue({
      error: "Leaf subagents cannot control other sessions.",
      status: "forbidden",
    });
    const result = await handleSubagentsSendAction(buildContext(), false);
    expect(result).toEqual({
      reply: { text: "⚠️ Leaf subagents cannot control other sessions." },
      shouldContinue: false,
    });
  });
});
