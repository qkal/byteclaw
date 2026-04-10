import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const loadGatewaySessionRowMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();
const chatSendMock = vi.fn();

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadGatewaySessionRow: (...args: unknown[]) => loadGatewaySessionRowMock(...args),
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
    readSessionMessages: (...args: unknown[]) => readSessionMessagesMock(...args),
  };
});

vi.mock("../../agents/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/subagent-registry-read.js")>(
    "../../agents/subagent-registry-read.js",
  );
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestSubagentRunByChildSessionKeyMock(...args),
  };
});

vi.mock("../session-subagent-reactivation.runtime.js", () => ({
  replaceSubagentRunAfterSteer: (...args: unknown[]) => replaceSubagentRunAfterSteerMock(...args),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": (...args: unknown[]) => chatSendMock(...args),
  },
}));

import { sessionsHandlers } from "./sessions.js";

describe("sessions.send completed subagent follow-up status", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    readSessionMessagesMock.mockReset();
    loadGatewaySessionRowMock.mockReset();
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
    chatSendMock.mockReset();
  });

  it("reactivates completed subagent sessions before broadcasting sessions.changed", async () => {
    const childSessionKey = "agent:main:subagent:followup";
    const completedRun = {
      childSessionKey,
      cleanup: "keep" as const,
      controllerSessionKey: "agent:main:main",
      createdAt: 1,
      endedAt: 3,
      outcome: { status: "ok" as const },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-old",
      startedAt: 2,
      task: "initial task",
    };

    loadSessionEntryMock.mockReturnValue({
      canonicalKey: childSessionKey,
      entry: { sessionId: "sess-followup" },
      storePath: "/tmp/sessions.json",
    });
    readSessionMessagesMock.mockReturnValue([]);
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(completedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);
    loadGatewaySessionRowMock.mockReturnValue({
      endedAt: undefined,
      runtimeMs: 10,
      startedAt: 123,
      status: "running",
    });
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-new", status: "started" }, undefined, undefined);
    });

    const broadcastToConnIds = vi.fn();
    const respond = vi.fn() as unknown as RespondFn;
    const context = {
      broadcastToConnIds,
      chatAbortControllers: new Map(),
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
    } as unknown as GatewayRequestContext;

    await sessionsHandlers["sessions.send"]({
      client: null,
      context,
      isWebchatConnect: () => false,
      params: {
        idempotencyKey: "run-new",
        key: childSessionKey,
        message: "follow-up",
      },
      req: { id: "req-1" } as never,
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        messageSeq: 1,
        runId: "run-new",
        status: "started",
      }),
      undefined,
      undefined,
    );
    expectSubagentFollowupReactivation({
      broadcastToConnIds,
      childSessionKey,
      completedRun,
      replaceSubagentRunAfterSteerMock,
    });
  });
});
