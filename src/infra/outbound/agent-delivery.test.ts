import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+1999" })),
  resolveSessionDeliveryTarget: vi.fn(
    (params: {
      entry?: {
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string | number;
        };
        lastChannel?: string;
        lastTo?: string;
        lastAccountId?: string;
        lastThreadId?: string | number;
      };
      requestedChannel?: string;
      explicitTo?: string;
      explicitThreadId?: string | number;
      turnSourceChannel?: string;
      turnSourceTo?: string;
      turnSourceAccountId?: string;
      turnSourceThreadId?: string | number;
    }) => {
      const sessionContext = params.entry?.deliveryContext ?? {
        accountId: params.entry?.lastAccountId,
        channel: params.entry?.lastChannel,
        threadId: params.entry?.lastThreadId,
        to: params.entry?.lastTo,
      };
      const lastChannel = params.turnSourceChannel ?? sessionContext.channel;
      const lastTo = params.turnSourceChannel ? params.turnSourceTo : sessionContext.to;
      const lastAccountId = params.turnSourceChannel
        ? params.turnSourceAccountId
        : sessionContext.accountId;
      const lastThreadId = params.turnSourceChannel
        ? params.turnSourceThreadId
        : sessionContext.threadId;
      const channel =
        params.requestedChannel === "last" || params.requestedChannel == null
          ? lastChannel
          : params.requestedChannel;
      const mode = params.explicitTo ? "explicit" : "implicit";
      const resolvedTo =
        params.explicitTo ?? (channel && channel === lastChannel ? lastTo : undefined);

      return {
        accountId: channel && channel === lastChannel ? lastAccountId : undefined,
        channel,
        lastAccountId,
        lastChannel,
        lastThreadId,
        lastTo,
        mode,
        threadId:
          params.explicitThreadId ??
          (channel && channel === lastChannel ? lastThreadId : undefined),
        threadIdExplicit: params.explicitThreadId != null,
        to: resolvedTo,
      };
    },
  ),
}));

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
  resolveSessionDeliveryTarget: mocks.resolveSessionDeliveryTarget,
}));

import type { OpenClawConfig } from "../../config/config.js";
let resolveAgentDeliveryPlan: typeof import("./agent-delivery.js").resolveAgentDeliveryPlan;
let resolveAgentOutboundTarget: typeof import("./agent-delivery.js").resolveAgentOutboundTarget;

beforeAll(async () => {
  ({ resolveAgentDeliveryPlan, resolveAgentOutboundTarget } = await import("./agent-delivery.js"));
});

beforeEach(() => {
  mocks.resolveOutboundTarget.mockClear();
  mocks.resolveSessionDeliveryTarget.mockClear();
});

function expectDeliveryPlan(params: Parameters<typeof resolveAgentDeliveryPlan>[0]) {
  return resolveAgentDeliveryPlan(params);
}

describe("agent delivery helpers", () => {
  it.each([
    {
      expected: {
        deliveryTargetMode: "implicit",
        resolvedAccountId: "work",
        resolvedChannel: "whatsapp",
        resolvedTo: "+1555",
      },
      params: {
        accountId: undefined,
        explicitTo: undefined,
        requestedChannel: "last",
        sessionEntry: {
          deliveryContext: { accountId: "work", channel: "whatsapp", to: "+1555" },
          sessionId: "s1",
          updatedAt: 1,
        },
        wantsDelivery: true,
      },
    },
    {
      expected: {
        deliveryTargetMode: undefined,
        resolvedChannel: "webchat",
      },
      params: {
        accountId: undefined,
        explicitTo: undefined,
        requestedChannel: "last",
        sessionEntry: undefined,
        wantsDelivery: true,
      },
    },
    {
      expected: {
        resolvedAccountId: "work",
        resolvedChannel: "whatsapp",
        resolvedTo: "+17775550123",
      },
      params: {
        accountId: undefined,
        requestedChannel: "last",
        sessionEntry: {
          deliveryContext: { accountId: "wrong", channel: "slack", to: "U_WRONG" },
          sessionId: "s4",
          updatedAt: 4,
        },
        turnSourceAccountId: "work",
        turnSourceChannel: "whatsapp",
        turnSourceTo: "+17775550123",
        wantsDelivery: true,
      },
    },
    {
      expected: {
        resolvedChannel: "whatsapp",
        resolvedTo: undefined,
      },
      params: {
        accountId: undefined,
        requestedChannel: "last",
        sessionEntry: {
          deliveryContext: { channel: "slack", to: "U_WRONG" },
          sessionId: "s5",
          updatedAt: 5,
        },
        turnSourceChannel: "whatsapp",
        wantsDelivery: true,
      },
    },
  ])("builds delivery plan for %j", ({ params, expected }) => {
    const plan = expectDeliveryPlan(params);
    expect(plan).toMatchObject(expected);
  });

  it("resolves fallback targets when no explicit destination is provided", () => {
    const plan = resolveAgentDeliveryPlan({
      accountId: undefined,
      explicitTo: undefined,
      requestedChannel: "last",
      sessionEntry: {
        deliveryContext: { channel: "whatsapp" },
        sessionId: "s2",
        updatedAt: 2,
      },
      wantsDelivery: true,
    });

    const resolved = resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan,
      targetMode: "implicit",
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledTimes(1);
    expect(resolved.resolvedTarget?.ok).toBe(true);
    expect(resolved.resolvedTo).toBe("+1999");
  });

  it("skips outbound target resolution when explicit target validation is disabled", () => {
    const plan = expectDeliveryPlan({
      accountId: undefined,
      explicitTo: "+1555",
      requestedChannel: "last",
      sessionEntry: {
        deliveryContext: { channel: "whatsapp", to: "+1555" },
        sessionId: "s3",
        updatedAt: 3,
      },
      wantsDelivery: true,
    });

    mocks.resolveOutboundTarget.mockClear();
    const resolved = resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan,
      targetMode: "explicit",
      validateExplicitTarget: false,
    });

    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
    expect(resolved.resolvedTo).toBe("+1555");
  });
});
