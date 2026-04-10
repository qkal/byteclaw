import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildOutboundSessionContext: vi.fn().mockReturnValue({ kind: "session" }),
  createOutboundSendDeps: vi.fn().mockReturnValue({ kind: "deps" }),
  deliverOutboundPayloads: vi.fn(),
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({ kind: "identity" }),
  resolveDeliveryTarget: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: mocks.resolveAgentOutboundIdentity,
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: mocks.buildOutboundSessionContext,
}));

vi.mock("../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: mocks.createOutboundSendDeps,
}));

vi.mock("../logging.js", () => ({
  getChildLogger: vi.fn(() => ({
    warn: mocks.warn,
  })),
}));

const { sendFailureNotificationAnnounce } = await import("./delivery.js");

describe("sendFailureNotificationAnnounce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDeliveryTarget.mockResolvedValue({
      accountId: "bot-a",
      channel: "telegram",
      mode: "explicit",
      ok: true,
      threadId: 42,
      to: "123",
    });
    mocks.deliverOutboundPayloads.mockResolvedValue([{ ok: true }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers failure alerts to the resolved explicit target with strict send settings", async () => {
    const deps = {} as never;
    const cfg = {} as never;

    await sendFailureNotificationAnnounce(
      deps,
      cfg,
      "main",
      "job-1",
      { accountId: "bot-a", channel: "telegram", to: "123" },
      "Cron failed",
    );

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(cfg, "main", {
      accountId: "bot-a",
      channel: "telegram",
      to: "123",
    });
    expect(mocks.buildOutboundSessionContext).toHaveBeenCalledWith({
      agentId: "main",
      cfg,
      sessionKey: "cron:job-1:failure",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        accountId: "bot-a",
        bestEffort: false,
        cfg,
        channel: "telegram",
        deps: { kind: "deps" },
        identity: { kind: "identity" },
        payloads: [{ text: "Cron failed" }],
        session: { kind: "session" },
        threadId: 42,
        to: "123",
      }),
    );
  });

  it("passes sessionKey through to delivery-target resolution", async () => {
    await sendFailureNotificationAnnounce(
      {} as never,
      {} as never,
      "main",
      "job-1",
      {
        channel: "telegram",
        sessionKey: "agent:main:telegram:direct:123:thread:99",
      },
      "Cron failed",
    );

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith({} as never, "main", {
      accountId: undefined,
      channel: "telegram",
      sessionKey: "agent:main:telegram:direct:123:thread:99",
      to: undefined,
    });
  });

  it("does not send when target resolution fails", async () => {
    mocks.resolveDeliveryTarget.mockResolvedValue({
      error: new Error("target missing"),
      ok: false,
    });

    await sendFailureNotificationAnnounce(
      {} as never,
      {} as never,
      "main",
      "job-1",
      { channel: "telegram", to: "123" },
      "Cron failed",
    );

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      { error: "target missing" },
      "cron: failed to resolve failure destination target",
    );
  });

  it("swallows outbound delivery errors after logging", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValue(new Error("send failed"));

    await expect(
      sendFailureNotificationAnnounce(
        {} as never,
        {} as never,
        "main",
        "job-1",
        { channel: "telegram", to: "123" },
        "Cron failed",
      ),
    ).resolves.toBeUndefined();

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        err: "send failed",
        to: "123",
      }),
      "cron: failure destination announce failed",
    );
  });
});
