import { describe, expect, it, vi } from "vitest";
import { resolveChannelApprovalAdapter, resolveChannelApprovalCapability } from "./approvals.js";

function createNativeRuntimeStub() {
  return {
    availability: {
      isConfigured: vi.fn(),
      shouldHandle: vi.fn(),
    },
    presentation: {
      buildExpiredResult: vi.fn(),
      buildPendingPayload: vi.fn(),
      buildResolvedResult: vi.fn(),
    },
    transport: {
      deliverPending: vi.fn(),
      prepareTarget: vi.fn(),
    },
  };
}

describe("resolveChannelApprovalCapability", () => {
  it("returns undefined when approvalCapability is absent", () => {
    expect(resolveChannelApprovalCapability({})).toBeUndefined();
  });

  it("returns approvalCapability as the canonical approval contract", () => {
    const capabilityAuth = vi.fn();
    const capabilityAvailability = vi.fn();
    const capabilityNativeRuntime = createNativeRuntimeStub();
    const delivery = { hasConfiguredDmRoute: vi.fn() };

    expect(
      resolveChannelApprovalCapability({
        approvalCapability: {
          authorizeActorAction: capabilityAuth,
          delivery,
          getActionAvailabilityState: capabilityAvailability,
          nativeRuntime: capabilityNativeRuntime,
        },
      }),
    ).toEqual({
      authorizeActorAction: capabilityAuth,
      delivery,
      getActionAvailabilityState: capabilityAvailability,
      native: undefined,
      nativeRuntime: capabilityNativeRuntime,
      render: undefined,
    });
  });
});

describe("resolveChannelApprovalAdapter", () => {
  it("returns only delivery/runtime surfaces from approvalCapability", () => {
    const delivery = { hasConfiguredDmRoute: vi.fn() };
    const nativeRuntime = createNativeRuntimeStub();
    const describeExecApprovalSetup = vi.fn();

    expect(
      resolveChannelApprovalAdapter({
        approvalCapability: {
          authorizeActorAction: vi.fn(),
          delivery,
          describeExecApprovalSetup,
          nativeRuntime,
        },
      }),
    ).toEqual({
      delivery,
      describeExecApprovalSetup,
      native: undefined,
      nativeRuntime,
      render: undefined,
    });
  });
});
