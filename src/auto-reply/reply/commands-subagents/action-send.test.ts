import { describe, expect, it, vi } from "vitest";

const { sendControlledSubagentMessage, steerControlledSubagentRun } = vi.hoisted(() => ({
  sendControlledSubagentMessage: vi.fn(),
  steerControlledSubagentRun: vi.fn(),
}));

vi.mock("../../../agents/subagent-control.js", () => ({
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
}));

vi.mock("./shared.js", () => ({
  COMMAND: "/subagents",
  resolveCommandSubagentController: () => ({
    callerIsSubagent: false,
    callerSessionKey: "agent:main:main",
    controlScope: "children",
    controllerSessionKey: "agent:main:main",
  }),
  resolveSubagentEntryForToken: () => ({
    entry: {
      childSessionKey: "agent:main:subagent:worker",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 5000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-target",
      startedAt: Date.now() - 4000,
      task: "worker task",
    },
  }),
  stopWithText: (text: string) => ({
    reply: { text },
    shouldContinue: false,
  }),
}));

import { handleSubagentsSendAction } from "./action-send.js";

describe("handleSubagentsSendAction", () => {
  it("surfaces finished-state text instead of reporting a fake successful send", async () => {
    sendControlledSubagentMessage.mockResolvedValueOnce({
      runId: "run-stale",
      status: "done",
      text: "worker task is already finished.",
    });

    const result = await handleSubagentsSendAction(
      {
        handledPrefix: "/subagents",
        params: { cfg: {} },
        requesterKey: "agent:main:main",
        restTokens: ["1", "continue"],
        runs: [],
      } as never,
      false,
    );

    expect(result).toEqual({
      reply: { text: "worker task is already finished." },
      shouldContinue: false,
    });
  });
});
