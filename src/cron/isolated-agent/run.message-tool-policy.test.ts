import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  dispatchCronDeliveryMock,
  isHeartbeatOnlyResponseMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      delivery: { mode: "none" },
      id: "message-tool-policy",
      name: "Message Tool Policy",
      payload: { kind: "agentTurn", message: "send a message" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
    } as never,
    message: "send a message",
    sessionKey: "cron:message-tool-policy",
  };
}

describe("runCronIsolatedAgentTurn message tool policy", () => {
  let previousFastTestEnv: string | undefined;

  async function expectMessageToolDisabledForPlan(plan: {
    requested: boolean;
    mode: "none" | "announce";
    channel?: string;
    to?: string;
  }) {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(plan);
    await runCronIsolatedAgentTurn(makeParams());
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(true);
  }

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      accountId: undefined,
      channel: "telegram",
      error: undefined,
      ok: true,
      to: "123",
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it('disables the message tool when delivery.mode is "none"', async () => {
    await expectMessageToolDisabledForPlan({
      mode: "none",
      requested: false,
    });
  });

  it("disables the message tool when cron delivery is active", async () => {
    await expectMessageToolDisabledForPlan({
      channel: "telegram",
      mode: "announce",
      requested: true,
      to: "123",
    });
  });

  it("keeps the message tool enabled for shared callers when delivery is not requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      mode: "none",
      requested: false,
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      deliveryContract: "shared",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(false);
  });

  it("skips cron delivery when output is heartbeat-only", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      channel: "telegram",
      mode: "announce",
      requested: true,
      to: "123",
    });
    isHeartbeatOnlyResponseMock.mockReturnValue(true);

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        delivery: { channel: "telegram", mode: "announce", to: "123" },
        id: "message-tool-policy",
        name: "Message Tool Policy",
        payload: { kind: "agentTurn", message: "send a message" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "isolated",
      } as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipHeartbeatDelivery: true,
      }),
    );
  });

  it("skips cron delivery when a shared caller already sent to the same target", async () => {
    mockRunCronFallbackPassthrough();
    const params = makeParams();
    const job = {
      delivery: { channel: "telegram", mode: "announce", to: "123" },
      id: "message-tool-policy",
      name: "Message Tool Policy",
      payload: { kind: "agentTurn", message: "send a message" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
    } as const;
    resolveCronDeliveryPlanMock.mockReturnValue({
      channel: "telegram",
      mode: "announce",
      requested: true,
      to: "123",
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [{ provider: "telegram", to: "123", tool: "message" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      payloads: [{ text: "sent" }],
    });

    await runCronIsolatedAgentTurn({
      ...params,
      deliveryContract: "shared",
      job: job as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipMessagingToolDelivery: true,
      }),
    );
  });
});
