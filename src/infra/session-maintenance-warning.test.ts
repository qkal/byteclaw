import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async () => []),
  deliveryContextFromSession: vi.fn(() => ({
    accountId: "acct-1",
    channel: "whatsapp",
    threadId: "thread-1",
    to: "+15550001",
  })),
  enqueueSystemEvent: vi.fn(),
  isDeliverableMessageChannel: vi.fn(() => true),
  normalizeMessageChannel: vi.fn((channel: string) => channel),
  resolveSessionAgentId: vi.fn(() => "agent-from-key"),
}));

type SessionMaintenanceWarningModule = typeof import("./session-maintenance-warning.js");

let deliverSessionMaintenanceWarning: SessionMaintenanceWarningModule["deliverSessionMaintenanceWarning"];
let resetSessionMaintenanceWarningForTests: SessionMaintenanceWarningModule["__testing"]["resetSessionMaintenanceWarningForTests"];

function createParams(
  overrides: Partial<Parameters<typeof deliverSessionMaintenanceWarning>[0]> = {},
): Parameters<typeof deliverSessionMaintenanceWarning>[0] {
  const sessionKey = overrides.sessionKey ?? `agent:${randomUUID()}:main`;
  return {
    cfg: {},
    entry: {} as never,
    sessionKey,
    warning: {
      activeSessionKey: sessionKey,
      maxEntries: 100,
      pruneAfterMs: 1_000,
      wouldCap: false,
      wouldPrune: true,
      ...(overrides.warning as object),
    } as never,
    ...overrides,
  };
}

describe("deliverSessionMaintenanceWarning", () => {
  let prevVitest: string | undefined;
  let prevNodeEnv: string | undefined;

  beforeAll(async () => {
    vi.doMock("../agents/agent-scope.js", () => ({
      resolveSessionAgentId: mocks.resolveSessionAgentId,
    }));
    vi.doMock("../utils/message-channel.js", () => ({
      isDeliverableMessageChannel: mocks.isDeliverableMessageChannel,
      normalizeMessageChannel: mocks.normalizeMessageChannel,
    }));
    vi.doMock("../utils/delivery-context.js", () => ({
      deliveryContextFromSession: mocks.deliveryContextFromSession,
    }));
    vi.doMock("./outbound/deliver-runtime.js", () => ({
      deliverOutboundPayloads: mocks.deliverOutboundPayloads,
    }));
    vi.doMock("./system-events.js", () => ({
      enqueueSystemEvent: mocks.enqueueSystemEvent,
    }));
    ({
      deliverSessionMaintenanceWarning,
      __testing: { resetSessionMaintenanceWarningForTests },
    } = await import("./session-maintenance-warning.js"));
  });

  beforeEach(() => {
    prevVitest = process.env.VITEST;
    prevNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    resetSessionMaintenanceWarningForTests();
    mocks.resolveSessionAgentId.mockClear();
    mocks.deliveryContextFromSession.mockClear();
    mocks.normalizeMessageChannel.mockClear();
    mocks.isDeliverableMessageChannel.mockClear();
    mocks.deliverOutboundPayloads.mockClear();
    mocks.enqueueSystemEvent.mockClear();
  });

  afterEach(() => {
    if (prevVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = prevVitest;
    }
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("forwards session context to outbound delivery", async () => {
    const params = createParams({ sessionKey: "agent:main:main" });

    await deliverSessionMaintenanceWarning(params);

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        session: { agentId: "agent-from-key", key: "agent:main:main" },
        to: "+15550001",
      }),
    );
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("suppresses duplicate warning contexts for the same session", async () => {
    const params = createParams();

    await deliverSessionMaintenanceWarning(params);
    await deliverSessionMaintenanceWarning(params);

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("falls back to a system event when the last target is not deliverable", async () => {
    mocks.deliveryContextFromSession.mockReturnValueOnce({
      accountId: "acct-1",
      channel: "debug",
      threadId: "thread-1",
      to: "+15550001",
    });
    mocks.isDeliverableMessageChannel.mockReturnValueOnce(false);

    await deliverSessionMaintenanceWarning(
      createParams({
        warning: {
          maxEntries: 10,
          pruneAfterMs: 3_600_000,
          wouldCap: true,
          wouldPrune: false,
        } as never,
      }),
    );

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("most recent 10 sessions"),
      expect.objectContaining({ sessionKey: expect.stringContaining("agent:") }),
    );
  });

  it("skips warning delivery in test mode", async () => {
    process.env.NODE_ENV = "test";

    await deliverSessionMaintenanceWarning(createParams());

    expect(mocks.deliveryContextFromSession).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("enqueues a system event when outbound delivery fails", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("boom"));

    await deliverSessionMaintenanceWarning(createParams());

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("older than 1 second"),
      expect.objectContaining({ sessionKey: expect.stringContaining("agent:") }),
    );
  });
});
