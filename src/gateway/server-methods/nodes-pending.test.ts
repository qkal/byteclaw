import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodePendingHandlers } from "./nodes-pending.js";

const mocks = vi.hoisted(() => ({
  drainNodePendingWork: vi.fn(),
  enqueueNodePendingWork: vi.fn(),
  maybeSendNodeWakeNudge: vi.fn(),
  maybeWakeNodeWithApns: vi.fn(),
  waitForNodeReconnect: vi.fn(),
}));

vi.mock("../node-pending-work.js", () => ({
  drainNodePendingWork: mocks.drainNodePendingWork,
  enqueueNodePendingWork: mocks.enqueueNodePendingWork,
}));

vi.mock("./nodes.js", () => ({
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS: 12_000,
  NODE_WAKE_RECONNECT_WAIT_MS: 3000,
  maybeSendNodeWakeNudge: mocks.maybeSendNodeWakeNudge,
  maybeWakeNodeWithApns: mocks.maybeWakeNodeWithApns,
  waitForNodeReconnect: mocks.waitForNodeReconnect,
}));

type RespondCall = [
  boolean,
  unknown?,
  {
    code?: number;
    message?: string;
    details?: unknown;
  }?,
];

function makeContext(overrides?: Partial<Record<string, unknown>>) {
  return {
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    nodeRegistry: {
      get: vi.fn(() => undefined),
    },
    ...overrides,
  };
}

describe("node.pending handlers", () => {
  beforeEach(() => {
    mocks.drainNodePendingWork.mockReset();
    mocks.enqueueNodePendingWork.mockReset();
    mocks.maybeWakeNodeWithApns.mockReset();
    mocks.maybeSendNodeWakeNudge.mockReset();
    mocks.waitForNodeReconnect.mockReset();
  });

  it("drains pending work for the connected node identity", async () => {
    mocks.drainNodePendingWork.mockReturnValue({
      hasMore: false,
      items: [{ id: "baseline-status", priority: "default", type: "status.request" }],
      revision: 2,
    });
    const respond = vi.fn();

    await nodePendingHandlers["node.pending.drain"]({
      client: { connect: { device: { id: "ios-node-1" } } } as never,
      context: makeContext() as never,
      isWebchatConnect: () => false,
      params: { maxItems: 3 },
      req: { id: "req-node-pending-drain", method: "node.pending.drain", type: "req" },
      respond: respond as never,
    });

    expect(mocks.drainNodePendingWork).toHaveBeenCalledWith("ios-node-1", {
      includeDefaultStatus: true,
      maxItems: 3,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        hasMore: false,
        items: [{ id: "baseline-status", priority: "default", type: "status.request" }],
        nodeId: "ios-node-1",
        revision: 2,
      },
      undefined,
    );
  });

  it("rejects node.pending.drain without a connected device identity", async () => {
    const respond = vi.fn();

    await nodePendingHandlers["node.pending.drain"]({
      client: null,
      context: makeContext() as never,
      isWebchatConnect: () => false,
      params: {},
      req: { id: "req-node-pending-drain-missing", method: "node.pending.drain", type: "req" },
      respond: respond as never,
    });

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.message).toContain("connected device identity");
  });

  it("enqueues pending work and wakes a disconnected node once", async () => {
    mocks.enqueueNodePendingWork.mockReturnValue({
      deduped: false,
      item: {
        createdAtMs: 100,
        expiresAtMs: null,
        id: "pending-1",
        priority: "high",
        type: "location.request",
      },
      revision: 4,
    });
    mocks.maybeWakeNodeWithApns.mockResolvedValue({
      apnsReason: null,
      apnsStatus: 200,
      available: true,
      durationMs: 12,
      path: "apns",
      throttled: false,
    });
    let connected = false;
    mocks.waitForNodeReconnect.mockImplementation(async () => {
      connected = true;
      return true;
    });
    const context = makeContext({
      nodeRegistry: {
        get: vi.fn(() => (connected ? { nodeId: "ios-node-2" } : undefined)),
      },
    });
    const respond = vi.fn();

    await nodePendingHandlers["node.pending.enqueue"]({
      client: null,
      context: context as never,
      isWebchatConnect: () => false,
      params: {
        nodeId: "ios-node-2",
        priority: "high",
        type: "location.request",
      },
      req: { id: "req-node-pending-enqueue", method: "node.pending.enqueue", type: "req" },
      respond: respond as never,
    });

    expect(mocks.enqueueNodePendingWork).toHaveBeenCalledWith({
      expiresInMs: undefined,
      nodeId: "ios-node-2",
      priority: "high",
      type: "location.request",
    });
    expect(mocks.maybeWakeNodeWithApns).toHaveBeenCalledWith("ios-node-2", {
      wakeReason: "node.pending",
    });
    expect(mocks.waitForNodeReconnect).toHaveBeenCalledWith({
      context,
      nodeId: "ios-node-2",
      timeoutMs: 3000,
    });
    expect(mocks.maybeSendNodeWakeNudge).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        nodeId: "ios-node-2",
        revision: 4,
        wakeTriggered: true,
      }),
      undefined,
    );
  });
});
