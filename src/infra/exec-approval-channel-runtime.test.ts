import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

const mockGatewayClientStarts = vi.hoisted(() => vi.fn());
const mockGatewayClientStops = vi.hoisted(() => vi.fn());
const mockGatewayClientRequests = vi.hoisted(() =>
  vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({
    ok: true,
  })),
);
const mockCreateOperatorApprovalsGatewayClient = vi.hoisted(() => vi.fn());
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: mockCreateOperatorApprovalsGatewayClient,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

let createExecApprovalChannelRuntime: typeof import("./exec-approval-channel-runtime.js").createExecApprovalChannelRuntime;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  mockGatewayClientStarts.mockReset();
  mockGatewayClientStops.mockReset();
  mockGatewayClientRequests.mockReset();
  mockGatewayClientRequests.mockImplementation(async (method: string) =>
    method.endsWith(".approval.list") ? [] : { ok: true },
  );
  loggerMocks.debug.mockReset();
  loggerMocks.error.mockReset();
  mockCreateOperatorApprovalsGatewayClient.mockReset().mockImplementation(async (params) => ({
    request: mockGatewayClientRequests,
    start: () => {
      mockGatewayClientStarts();
      queueMicrotask(() => {
        params.onHelloOk?.({ type: "hello-ok" } as never);
      });
    },
    stop: mockGatewayClientStops,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeAll(async () => {
  ({ createExecApprovalChannelRuntime } = await import("./exec-approval-channel-runtime.js"));
});

describe("createExecApprovalChannelRuntime", () => {
  it("does not connect when the adapter is not configured", async () => {
    const runtime = createExecApprovalChannelRuntime({
      cfg: {} as never,
      clientDisplayName: "Test Exec Approvals",
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
      isConfigured: () => false,
      label: "test/exec-approvals",
      shouldHandle: () => true,
    });

    await runtime.start();

    expect(mockCreateOperatorApprovalsGatewayClient).not.toHaveBeenCalled();
  });

  it("tracks pending requests and only expires the matching approval id", async () => {
    vi.useFakeTimers();
    const finalizedExpired = vi.fn(async () => undefined);
    const finalizedResolved = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime({
      cfg: {} as never,
      clientDisplayName: "Test Exec Approvals",
      deliverRequested: async (request) => [{ id: request.id }],
      finalizeExpired: finalizedExpired,
      finalizeResolved: finalizedResolved,
      isConfigured: () => true,
      label: "test/exec-approvals",
      nowMs: () => 1000,
      shouldHandle: () => true,
    });

    await runtime.handleRequested({
      createdAtMs: 1000,
      expiresAtMs: 2000,
      id: "abc",
      request: {
        command: "echo abc",
      },
    });
    await runtime.handleRequested({
      createdAtMs: 1000,
      expiresAtMs: 2000,
      id: "xyz",
      request: {
        command: "echo xyz",
      },
    });

    await runtime.handleExpired("abc");

    expect(finalizedExpired).toHaveBeenCalledTimes(1);
    expect(finalizedExpired).toHaveBeenCalledWith({
      entries: [{ id: "abc" }],
      request: expect.objectContaining({ id: "abc" }),
    });
    expect(finalizedResolved).not.toHaveBeenCalled();

    await runtime.handleResolved({
      decision: "allow-once",
      id: "xyz",
      ts: 1500,
    });

    expect(finalizedResolved).toHaveBeenCalledTimes(1);
    expect(finalizedResolved).toHaveBeenCalledWith({
      entries: [{ id: "xyz" }],
      request: expect.objectContaining({ id: "xyz" }),
      resolved: expect.objectContaining({ decision: "allow-once", id: "xyz" }),
    });
  });

  it("finalizes approvals that resolve while delivery is still in flight", async () => {
    const pendingDelivery = createDeferred<{ id: string }[]>();
    const finalizeResolved = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      cfg: {} as never,
      clientDisplayName: "Test Plugin Approvals",
      deliverRequested: async () => pendingDelivery.promise,
      eventKinds: ["plugin"],
      finalizeResolved,
      isConfigured: () => true,
      label: "test/plugin-approvals",
      shouldHandle: () => true,
    });

    const requestPromise = runtime.handleRequested({
      createdAtMs: 1000,
      expiresAtMs: 2000,
      id: "plugin:abc",
      request: {
        description: "Let plugin proceed",
        title: "Plugin approval",
      },
    });
    await runtime.handleResolved({
      decision: "allow-once",
      id: "plugin:abc",
      ts: 1500,
    });

    pendingDelivery.resolve([{ id: "plugin:abc" }]);
    await requestPromise;

    expect(finalizeResolved).toHaveBeenCalledWith({
      entries: [{ id: "plugin:abc" }],
      request: expect.objectContaining({ id: "plugin:abc" }),
      resolved: expect.objectContaining({ decision: "allow-once", id: "plugin:abc" }),
    });
  });

  it("routes gateway requests through the shared client", async () => {
    const runtime = createExecApprovalChannelRuntime({
      cfg: {} as never,
      clientDisplayName: "Test Exec Approvals",
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
      isConfigured: () => true,
      label: "test/exec-approvals",
      shouldHandle: () => true,
    });

    await runtime.start();
    await runtime.request("exec.approval.resolve", { decision: "deny", id: "abc" });

    expect(mockGatewayClientStarts).toHaveBeenCalledTimes(1);
    expect(mockGatewayClientRequests).toHaveBeenCalledWith("exec.approval.resolve", {
      decision: "deny",
      id: "abc",
    });
  });

  it("can retry start after gateway client creation fails", async () => {
    const boom = new Error("boom");
    mockCreateOperatorApprovalsGatewayClient
      .mockRejectedValueOnce(boom)
      .mockImplementationOnce(async (params) => ({
        request: mockGatewayClientRequests,
        start: () => {
          mockGatewayClientStarts();
          queueMicrotask(() => {
            params.onHelloOk?.({ type: "hello-ok" } as never);
          });
        },
        stop: mockGatewayClientStops,
      }));
    const runtime = createExecApprovalChannelRuntime({
      cfg: {} as never,
      clientDisplayName: "Test Exec Approvals",
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
      isConfigured: () => true,
      label: "test/exec-approvals",
      shouldHandle: () => true,
    });

    await expect(runtime.start()).rejects.toThrow("boom");
    await runtime.start();

    expect(mockCreateOperatorApprovalsGatewayClient).toHaveBeenCalledTimes(2);
    expect(mockGatewayClientStarts).toHaveBeenCalledTimes(1);
  });

  it("does not leave a gateway client running when stop wins the startup race", async () => {
    const pendingClient = createDeferred<GatewayClient>();
    mockCreateOperatorApprovalsGatewayClient.mockReturnValueOnce(pendingClient.promise);
    const runtime = createExecApprovalChannelRuntime({
      cfg: {} as never,
      clientDisplayName: "Test Exec Approvals",
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
      isConfigured: () => true,
      label: "test/exec-approvals",
      shouldHandle: () => true,
    });

    const startPromise = runtime.start();
    const stopPromise = runtime.stop();
    pendingClient.resolve({
      request: mockGatewayClientRequests as GatewayClient["request"],
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
    } as unknown as GatewayClient);
    await startPromise;
    await stopPromise;

    expect(mockGatewayClientStarts).not.toHaveBeenCalled();
    expect(mockGatewayClientStops).toHaveBeenCalledTimes(1);
    await expect(runtime.request("exec.approval.resolve", { id: "abc" })).rejects.toThrow(
      "gateway client not connected",
    );
  });

  it("logs async request handling failures from gateway events", async () => {
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      cfg: {} as never,
      clientDisplayName: "Test Plugin Approvals",
      deliverRequested: async () => {
        throw new Error("deliver failed");
      },
      eventKinds: ["plugin"],
      finalizeResolved: async () => undefined,
      isConfigured: () => true,
      label: "test/plugin-approvals",
      shouldHandle: () => true,
    });

    await runtime.start();
    const clientParams = mockCreateOperatorApprovalsGatewayClient.mock.calls[0]?.[0] as
      | { onEvent?: (evt: { event: string; payload: unknown }) => void }
      | undefined;

    clientParams?.onEvent?.({
      event: "plugin.approval.requested",
      payload: {
        createdAtMs: 1000,
        expiresAtMs: 2000,
        id: "plugin:abc",
        request: {
          description: "Let plugin proceed",
          title: "Plugin approval",
        },
      },
    });

    await vi.waitFor(() => {
      expect(loggerMocks.error).toHaveBeenCalledWith(
        "error handling approval request: deliver failed",
      );
    });
  });

  it("logs async expiration handling failures", async () => {
    vi.useFakeTimers();
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      cfg: {} as never,
      clientDisplayName: "Test Plugin Approvals",
      deliverRequested: async (request) => [{ id: request.id }],
      eventKinds: ["plugin"],
      finalizeExpired: async () => {
        throw new Error("expire failed");
      },
      finalizeResolved: async () => undefined,
      isConfigured: () => true,
      label: "test/plugin-approvals",
      nowMs: () => 1000,
      shouldHandle: () => true,
    });

    await runtime.handleRequested({
      createdAtMs: 1000,
      expiresAtMs: 1001,
      id: "plugin:abc",
      request: {
        description: "Let plugin proceed",
        title: "Plugin approval",
      },
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(loggerMocks.error).toHaveBeenCalledWith(
      "error handling approval expiration: expire failed",
    );
  });

  it("subscribes to plugin approval events when requested", async () => {
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const finalizeResolved = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      cfg: {} as never,
      clientDisplayName: "Test Plugin Approvals",
      deliverRequested,
      eventKinds: ["plugin"],
      finalizeResolved,
      isConfigured: () => true,
      label: "test/plugin-approvals",
      shouldHandle: () => true,
    });

    await runtime.start();
    const clientParams = mockCreateOperatorApprovalsGatewayClient.mock.calls[0]?.[0] as
      | { onEvent?: (evt: { event: string; payload: unknown }) => void }
      | undefined;
    expect(clientParams?.onEvent).toBeTypeOf("function");

    clientParams?.onEvent?.({
      event: "plugin.approval.requested",
      payload: {
        createdAtMs: 1000,
        expiresAtMs: 2000,
        id: "plugin:abc",
        request: {
          description: "Let plugin proceed",
          title: "Plugin approval",
        },
      },
    });
    await vi.waitFor(() => {
      expect(deliverRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "plugin:abc",
        }),
      );
    });

    clientParams?.onEvent?.({
      event: "plugin.approval.resolved",
      payload: {
        decision: "allow-once",
        id: "plugin:abc",
        ts: 1500,
      },
    });
    await vi.waitFor(() => {
      expect(finalizeResolved).toHaveBeenCalledWith({
        entries: [{ id: "plugin:abc" }],
        request: expect.objectContaining({ id: "plugin:abc" }),
        resolved: expect.objectContaining({ decision: "allow-once", id: "plugin:abc" }),
      });
    });
  });

  it("replays pending approvals after the gateway connection is ready", async () => {
    mockGatewayClientRequests.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return [
          {
            createdAtMs: 1000,
            expiresAtMs: 2000,
            id: "abc",
            request: {
              command: "echo abc",
            },
          },
        ];
      }
      return { ok: true };
    });
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const runtime = createExecApprovalChannelRuntime({
      cfg: {} as never,
      clientDisplayName: "Test Replay",
      deliverRequested,
      finalizeResolved: async () => undefined,
      isConfigured: () => true,
      label: "test/replay",
      shouldHandle: () => true,
    });

    await runtime.start();

    expect(mockGatewayClientRequests).toHaveBeenCalledWith("exec.approval.list", {});
    expect(deliverRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "abc",
      }),
    );
  });

  it("ignores live duplicate approval events after replay", async () => {
    mockGatewayClientRequests.mockImplementation(async (method: string) => {
      if (method === "plugin.approval.list") {
        return [
          {
            createdAtMs: 1000,
            expiresAtMs: 2000,
            id: "plugin:abc",
            request: {
              description: "Let plugin proceed",
              title: "Plugin approval",
            },
          },
        ];
      }
      return { ok: true };
    });
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      cfg: {} as never,
      clientDisplayName: "Test Plugin Replay",
      deliverRequested,
      eventKinds: ["plugin"],
      finalizeResolved: async () => undefined,
      isConfigured: () => true,
      label: "test/plugin-replay",
      shouldHandle: () => true,
    });

    await runtime.start();
    const clientParams = mockCreateOperatorApprovalsGatewayClient.mock.calls[0]?.[0] as
      | { onEvent?: (evt: { event: string; payload: unknown }) => void }
      | undefined;
    clientParams?.onEvent?.({
      event: "plugin.approval.requested",
      payload: {
        createdAtMs: 1000,
        expiresAtMs: 2000,
        id: "plugin:abc",
        request: {
          description: "Let plugin proceed",
          title: "Plugin approval",
        },
      },
    });
    await Promise.resolve();

    expect(deliverRequested).toHaveBeenCalledTimes(1);
  });

  it("does not replay approvals after stop wins once hello is already complete", async () => {
    const replayDeferred = createDeferred<
      {
        id: string;
        request: { command: string };
        createdAtMs: number;
        expiresAtMs: number;
      }[]
    >();
    mockGatewayClientRequests.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return replayDeferred.promise;
      }
      return { ok: true };
    });
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const runtime = createExecApprovalChannelRuntime({
      cfg: {} as never,
      clientDisplayName: "Test Replay Stop",
      deliverRequested,
      finalizeResolved: async () => undefined,
      isConfigured: () => true,
      label: "test/replay-stop-after-ready",
      shouldHandle: () => true,
    });

    const startPromise = runtime.start();
    await vi.waitFor(() => {
      expect(mockGatewayClientRequests).toHaveBeenCalledWith("exec.approval.list", {});
    });

    const stopPromise = runtime.stop();
    replayDeferred.resolve([
      {
        createdAtMs: 1000,
        expiresAtMs: 2000,
        id: "abc",
        request: {
          command: "echo abc",
        },
      },
    ]);

    await startPromise;
    await stopPromise;

    expect(deliverRequested).not.toHaveBeenCalled();
    expect(mockGatewayClientStops).toHaveBeenCalled();
  });

  it("clears pending state when delivery throws", async () => {
    const deliverRequested = vi
      .fn<() => Promise<{ id: string }[]>>()
      .mockRejectedValueOnce(new Error("deliver failed"))
      .mockResolvedValueOnce([{ id: "abc" }]);
    const finalizeResolved = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime({
      cfg: {} as never,
      clientDisplayName: "Test Delivery Failure",
      deliverRequested,
      finalizeResolved,
      isConfigured: () => true,
      label: "test/delivery-failure",
      shouldHandle: () => true,
    });

    await expect(
      runtime.handleRequested({
        createdAtMs: 1000,
        expiresAtMs: 2000,
        id: "abc",
        request: {
          command: "echo abc",
        },
      }),
    ).rejects.toThrow("deliver failed");

    await runtime.handleRequested({
      createdAtMs: 1000,
      expiresAtMs: 2000,
      id: "abc",
      request: {
        command: "echo abc",
      },
    });
    await runtime.handleResolved({
      decision: "allow-once",
      id: "abc",
      ts: 1500,
    });

    expect(finalizeResolved).toHaveBeenCalledWith({
      entries: [{ id: "abc" }],
      request: expect.objectContaining({ id: "abc" }),
      resolved: expect.objectContaining({ decision: "allow-once", id: "abc" }),
    });
  });
});
