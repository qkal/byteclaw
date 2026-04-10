import { describe, expect, it, vi } from "vitest";
import {
  type ChannelApprovalNativeRuntimeAdapter,
  createChannelApprovalHandlerFromCapability,
  createLazyChannelApprovalNativeRuntimeAdapter,
} from "./approval-handler-runtime.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

type ApprovalCapability = NonNullable<
  Parameters<typeof createChannelApprovalHandlerFromCapability>[0]["capability"]
>;
type ApprovalNativeAdapter = NonNullable<ApprovalCapability["native"]>;

const TEST_HANDLER_PARAMS = {
  cfg: { channels: {} } as never,
  channel: "test",
  channelLabel: "Test",
  clientDisplayName: "Test Approval Handler",
  label: "test/approval-handler",
} as const;

function makeSequentialPendingDeliveryMock() {
  return vi
    .fn()
    .mockResolvedValueOnce({ messageId: "1" })
    .mockResolvedValueOnce({ messageId: "2" });
}

function makeSequentialPendingBindingMock() {
  return vi
    .fn()
    .mockResolvedValueOnce({ bindingId: "bound-1" })
    .mockResolvedValueOnce({ bindingId: "bound-2" });
}

function makeExecApprovalRequest(id: string): ExecApprovalRequest {
  return {
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    id,
    request: {
      command: "echo hi",
      turnSourceChannel: "test",
      turnSourceTo: "origin-chat",
    },
  };
}

function makeNativeApprovalCapability(
  params: {
    preferredSurface?: ReturnType<
      ApprovalNativeAdapter["describeDeliveryCapabilities"]
    >["preferredSurface"];
    supportsApproverDmSurface?: boolean;
    resolveApproverDmTargets?: ApprovalNativeAdapter["resolveApproverDmTargets"];
    resolveApprovalKind?: ChannelApprovalNativeRuntimeAdapter["resolveApprovalKind"];
    buildResolvedResult?: ChannelApprovalNativeRuntimeAdapter["presentation"]["buildResolvedResult"];
    unbindPending?: NonNullable<
      ChannelApprovalNativeRuntimeAdapter["interactions"]
    >["unbindPending"];
    prepareTarget?: ChannelApprovalNativeRuntimeAdapter["transport"]["prepareTarget"];
    deliverPending?: ChannelApprovalNativeRuntimeAdapter["transport"]["deliverPending"];
    bindPending?: NonNullable<ChannelApprovalNativeRuntimeAdapter["interactions"]>["bindPending"];
  } = {},
): ApprovalCapability {
  const preferredSurface = params.preferredSurface ?? "origin";
  return {
    native: {
      describeDeliveryCapabilities: vi.fn().mockReturnValue({
        enabled: true,
        notifyOriginWhenDmOnly: false,
        preferredSurface,
        supportsApproverDmSurface: params.supportsApproverDmSurface ?? false,
        supportsOriginSurface: true,
      }),
      resolveOriginTarget: vi.fn().mockReturnValue({ to: "origin-chat" }),
      ...(params.resolveApproverDmTargets
        ? { resolveApproverDmTargets: params.resolveApproverDmTargets }
        : {}),
    },
    nativeRuntime: {
      availability: {
        isConfigured: vi.fn().mockReturnValue(true),
        shouldHandle: vi.fn().mockReturnValue(true),
      },
      interactions: {
        bindPending: params.bindPending ?? vi.fn().mockResolvedValue({ bindingId: "bound" }),
        unbindPending: params.unbindPending,
      },
      presentation: {
        buildExpiredResult: vi.fn(),
        buildPendingPayload: vi.fn().mockResolvedValue({ text: "pending" }),
        buildResolvedResult: params.buildResolvedResult ?? vi.fn(),
      },
      resolveApprovalKind: params.resolveApprovalKind,
      transport: {
        deliverPending: params.deliverPending ?? vi.fn().mockResolvedValue({ messageId: "1" }),
        prepareTarget:
          params.prepareTarget ??
          vi.fn().mockResolvedValue({
            dedupeKey: "origin-chat",
            target: { to: "origin-chat" },
          }),
      },
    },
  };
}

function createTestApprovalHandler(capability: ApprovalCapability) {
  return createChannelApprovalHandlerFromCapability({
    capability,
    ...TEST_HANDLER_PARAMS,
  });
}

describe("createChannelApprovalHandlerFromCapability", () => {
  it("returns null when the capability does not expose a native runtime", async () => {
    await expect(
      createChannelApprovalHandlerFromCapability({
        capability: {},
        ...TEST_HANDLER_PARAMS,
      }),
    ).resolves.toBeNull();
  });

  it("returns a runtime when the capability exposes a native runtime", async () => {
    const runtime = await createChannelApprovalHandlerFromCapability({
      capability: {
        nativeRuntime: {
          availability: {
            isConfigured: vi.fn().mockReturnValue(true),
            shouldHandle: vi.fn().mockReturnValue(true),
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
        },
      },
      ...TEST_HANDLER_PARAMS,
    });

    expect(runtime).not.toBeNull();
  });

  it("preserves the original request and resolved approval kind when stop-time cleanup unbinds", async () => {
    const unbindPending = vi.fn();
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        resolveApprovalKind: vi.fn().mockReturnValue("plugin"),
        unbindPending,
      }),
    );

    expect(runtime).not.toBeNull();
    const request = {
      expiresAtMs: Date.now() + 60_000,
      id: "custom:1",
      request: {
        turnSourceChannel: "test",
        turnSourceTo: "origin-chat",
      },
    } as never;

    await runtime?.handleRequested(request);
    await runtime?.stop();

    expect(unbindPending).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalKind: "plugin",
        request,
      }),
    );
  });

  it("ignores duplicate pending request ids before finalization", async () => {
    const unbindPending = vi.fn();
    const buildResolvedResult = vi.fn().mockResolvedValue({ kind: "leave" });
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        bindPending: makeSequentialPendingBindingMock(),
        buildResolvedResult,
        deliverPending: makeSequentialPendingDeliveryMock(),
        unbindPending,
      }),
    );

    expect(runtime).not.toBeNull();
    const request = makeExecApprovalRequest("exec:1");

    await runtime?.handleRequested(request);
    await runtime?.handleRequested(request);
    await runtime?.handleResolved({
      decision: "approved",
      id: "exec:1",
      resolvedBy: "operator",
    } as never);

    expect(unbindPending).toHaveBeenCalledTimes(1);
    expect(unbindPending).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: { bindingId: "bound-1" },
        entry: { messageId: "1" },
        request,
      }),
    );
    expect(buildResolvedResult).toHaveBeenCalledTimes(1);
  });

  it("continues finalization cleanup after one resolved entry unbind failure", async () => {
    const unbindPending = vi
      .fn()
      .mockRejectedValueOnce(new Error("unbind failed"))
      .mockResolvedValueOnce(undefined);
    const buildResolvedResult = vi.fn().mockResolvedValue({ kind: "leave" });
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        bindPending: makeSequentialPendingBindingMock(),
        buildResolvedResult,
        deliverPending: makeSequentialPendingDeliveryMock(),
        preferredSurface: "both",
        prepareTarget: vi.fn().mockImplementation(async ({ plannedTarget }) => ({
          dedupeKey: String(plannedTarget.target.to),
          target: { to: plannedTarget.target.to },
        })),
        resolveApproverDmTargets: vi.fn().mockResolvedValue([{ to: "approver-dm" }]),
        supportsApproverDmSurface: true,
        unbindPending,
      }),
    );

    const request = makeExecApprovalRequest("exec:2");

    await runtime?.handleRequested(request);
    await expect(
      runtime?.handleResolved({
        decision: "approved",
        id: "exec:2",
        resolvedBy: "operator",
      } as never),
    ).resolves.toBeUndefined();

    expect(unbindPending).toHaveBeenCalledTimes(2);
    expect(buildResolvedResult).toHaveBeenCalledTimes(1);
    expect(buildResolvedResult).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: { messageId: "2" },
      }),
    );
  });

  it("continues stop-time unbind cleanup when one binding throws", async () => {
    const unbindPending = vi
      .fn()
      .mockRejectedValueOnce(new Error("unbind failed"))
      .mockResolvedValueOnce(undefined);
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        bindPending: makeSequentialPendingBindingMock(),
        deliverPending: makeSequentialPendingDeliveryMock(),
        unbindPending,
      }),
    );

    const request = makeExecApprovalRequest("exec:stop-1");

    await runtime?.handleRequested(request);
    await runtime?.handleRequested({
      ...request,
      id: "exec:stop-2",
    });

    await expect(runtime?.stop()).resolves.toBeUndefined();
    expect(unbindPending).toHaveBeenCalledTimes(2);
    await expect(runtime?.stop()).resolves.toBeUndefined();
    expect(unbindPending).toHaveBeenCalledTimes(2);
  });
});

describe("createLazyChannelApprovalNativeRuntimeAdapter", () => {
  it("loads the runtime lazily and reuses the loaded adapter", async () => {
    const explicitIsConfigured = vi.fn().mockReturnValue(true);
    const explicitShouldHandle = vi.fn().mockReturnValue(false);
    const buildPendingPayload = vi.fn().mockResolvedValue({ text: "pending" });
    const load = vi.fn().mockResolvedValue({
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      presentation: {
        buildExpiredResult: vi.fn(),
        buildPendingPayload,
        buildResolvedResult: vi.fn(),
      },
      transport: {
        deliverPending: vi.fn(),
        prepareTarget: vi.fn(),
      },
    });
    const adapter = createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec"],
      isConfigured: explicitIsConfigured,
      load,
      shouldHandle: explicitShouldHandle,
    });
    const cfg = { channels: {} } as never;
    const request = { id: "exec:1" } as never;
    const view = {} as never;

    expect(adapter.eventKinds).toEqual(["exec"]);
    expect(adapter.availability.isConfigured({ cfg })).toBe(true);
    expect(adapter.availability.shouldHandle({ cfg, request })).toBe(false);
    await expect(
      adapter.presentation.buildPendingPayload({
        approvalKind: "exec",
        cfg,
        nowMs: 1,
        request,
        view,
      }),
    ).resolves.toEqual({ text: "pending" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(explicitIsConfigured).toHaveBeenCalledWith({ cfg });
    expect(explicitShouldHandle).toHaveBeenCalledWith({ cfg, request });
    expect(buildPendingPayload).toHaveBeenCalledWith({
      approvalKind: "exec",
      cfg,
      nowMs: 1,
      request,
      view,
    });
  });

  it("keeps observe hooks synchronous and only uses the already-loaded runtime", async () => {
    const onDelivered = vi.fn();
    const load = vi.fn().mockResolvedValue({
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      observe: {
        onDelivered,
      },
      presentation: {
        buildExpiredResult: vi.fn(),
        buildPendingPayload: vi.fn().mockResolvedValue({ text: "pending" }),
        buildResolvedResult: vi.fn(),
      },
      transport: {
        deliverPending: vi.fn(),
        prepareTarget: vi.fn(),
      },
    });
    const adapter = createLazyChannelApprovalNativeRuntimeAdapter({
      isConfigured: vi.fn().mockReturnValue(true),
      load,
      shouldHandle: vi.fn().mockReturnValue(true),
    });

    adapter.observe?.onDelivered?.({ request: { id: "exec:1" } } as never);
    expect(load).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();

    await adapter.presentation.buildPendingPayload({
      approvalKind: "exec",
      cfg: {} as never,
      nowMs: 1,
      request: { id: "exec:1" } as never,
      view: {} as never,
    });
    expect(load).toHaveBeenCalledTimes(1);

    adapter.observe?.onDelivered?.({ request: { id: "exec:1" } } as never);
    expect(onDelivered).toHaveBeenCalledWith({ request: { id: "exec:1" } });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
