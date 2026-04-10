import { expect } from "vitest";

export function expectSubagentFollowupReactivation(params: {
  replaceSubagentRunAfterSteerMock: unknown;
  broadcastToConnIds: unknown;
  completedRun: unknown;
  childSessionKey: string;
}) {
  expect(params.replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
    fallback: params.completedRun,
    nextRunId: "run-new",
    previousRunId: "run-old",
    runTimeoutSeconds: 0,
  });
  expect(params.broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({
      endedAt: undefined,
      reason: "send",
      sessionKey: params.childSessionKey,
      startedAt: 123,
      status: "running",
    }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
}
