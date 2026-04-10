import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { maybeWakeNodeWithApns, nodeHandlers } from "./nodes.js";

interface MockNodeCommandPolicyParams {
  command: string;
  declaredCommands?: string[];
  allowlist: Set<string>;
}

const mocks = vi.hoisted(() => ({
  clearApnsRegistrationIfCurrent: vi.fn(),
  isNodeCommandAllowed: vi.fn<
    (params: MockNodeCommandPolicyParams) => { ok: true } | { ok: false; reason: string }
  >(() => ({ ok: true })),
  loadApnsRegistration: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  resolveNodeCommandAllowlist: vi.fn<() => Set<string>>(() => new Set()),
  sanitizeNodeInvokeParamsForForwarding: vi.fn(({ rawParams }: { rawParams: unknown }) => ({
    ok: true,
    params: rawParams,
  })),
  sendApnsAlert: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../node-command-policy.js", () => ({
  isNodeCommandAllowed: mocks.isNodeCommandAllowed,
  resolveNodeCommandAllowlist: mocks.resolveNodeCommandAllowlist,
}));

vi.mock("../node-invoke-sanitize.js", () => ({
  sanitizeNodeInvokeParamsForForwarding: mocks.sanitizeNodeInvokeParamsForForwarding,
}));

vi.mock("../../infra/push-apns.js", () => ({
  clearApnsRegistrationIfCurrent: mocks.clearApnsRegistrationIfCurrent,
  loadApnsRegistration: mocks.loadApnsRegistration,
  resolveApnsAuthConfigFromEnv: mocks.resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv: mocks.resolveApnsRelayConfigFromEnv,
  sendApnsAlert: mocks.sendApnsAlert,
  sendApnsBackgroundWake: mocks.sendApnsBackgroundWake,
  shouldClearStoredApnsRegistration: mocks.shouldClearStoredApnsRegistration,
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

interface TestNodeSession {
  nodeId: string;
  commands: string[];
  platform?: string;
}

const WAKE_WAIT_TIMEOUT_MS = 3001;
const DEFAULT_RELAY_CONFIG = {
  baseUrl: "https://relay.example.com",
  timeoutMs: 1000,
} as const;
type WakeResultOverrides = Partial<{
  ok: boolean;
  status: number;
  reason: string;
  tokenSuffix: string;
  topic: string;
  environment: "sandbox" | "production";
  transport: "direct" | "relay";
}>;

function directRegistration(nodeId: string) {
  return {
    environment: "sandbox" as const,
    nodeId,
    token: "abcd1234abcd1234abcd1234abcd1234",
    topic: "ai.openclaw.ios",
    transport: "direct" as const,
    updatedAtMs: 1,
  };
}

function relayRegistration(nodeId: string) {
  return {
    distribution: "official" as const,
    environment: "production" as const,
    installationId: "install-123",
    nodeId,
    relayHandle: "relay-handle-123",
    sendGrant: "send-grant-123",
    tokenDebugSuffix: "abcd1234",
    topic: "ai.openclaw.ios",
    transport: "relay" as const,
    updatedAtMs: 1,
  };
}

function mockDirectWakeConfig(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.loadApnsRegistration.mockResolvedValue(directRegistration(nodeId));
  mocks.resolveApnsAuthConfigFromEnv.mockResolvedValue({
    ok: true,
    value: {
      keyId: "KEY123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      teamId: "TEAM123", // Pragma: allowlist secret
    },
  });
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    environment: "sandbox",
    ok: true,
    status: 200,
    tokenSuffix: "1234abcd",
    topic: "ai.openclaw.ios",
    transport: "direct",
    ...overrides,
  });
}

function mockRelayWakeConfig(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.loadConfig.mockReturnValue({
    gateway: {
      push: {
        apns: {
          relay: DEFAULT_RELAY_CONFIG,
        },
      },
    },
  });
  mocks.loadApnsRegistration.mockResolvedValue(relayRegistration(nodeId));
  mocks.resolveApnsRelayConfigFromEnv.mockReturnValue({
    ok: true,
    value: DEFAULT_RELAY_CONFIG,
  });
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    environment: "production",
    ok: true,
    status: 200,
    tokenSuffix: "abcd1234",
    topic: "ai.openclaw.ios",
    transport: "relay",
    ...overrides,
  });
}

function makeNodeInvokeParams(overrides?: Partial<Record<string, unknown>>) {
  return {
    command: "camera.capture",
    idempotencyKey: "idem-node-invoke",
    nodeId: "ios-node-1",
    params: { quality: "high" },
    timeoutMs: 5000,
    ...overrides,
  };
}

async function invokeNode(params: {
  nodeRegistry: {
    get: (nodeId: string) => TestNodeSession | undefined;
    invoke: (payload: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey?: string;
    }) => Promise<{
      ok: boolean;
      payload?: unknown;
      payloadJSON?: string | null;
      error?: { code?: string; message?: string } | null;
    }>;
  };
  requestParams?: Partial<Record<string, unknown>>;
}) {
  const respond = vi.fn();
  const logGateway = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  await nodeHandlers["node.invoke"]({
    client: null,
    context: {
      execApprovalManager: undefined,
      logGateway,
      nodeRegistry: params.nodeRegistry,
    } as never,
    isWebchatConnect: () => false,
    params: makeNodeInvokeParams(params.requestParams),
    req: { id: "req-node-invoke", method: "node.invoke", type: "req" },
    respond: respond as never,
  });
  return respond;
}

function createNodeClient(nodeId: string, commands?: string[]) {
  return {
    connect: {
      ...(commands ? { commands } : {}),
      client: {
        id: nodeId,
        mode: "node" as const,
        name: "ios-test",
        platform: "iOS 26.4.0",
        version: "test",
      },
      role: "node" as const,
    },
  };
}

async function pullPending(nodeId: string, commands?: string[]) {
  const respond = vi.fn();
  await nodeHandlers["node.pending.pull"]({
    client: createNodeClient(nodeId, commands) as never,
    context: {} as never,
    isWebchatConnect: () => false,
    params: {},
    req: { id: "req-node-pending", method: "node.pending.pull", type: "req" },
    respond: respond as never,
  });
  return respond;
}

async function ackPending(nodeId: string, ids: string[], commands?: string[]) {
  const respond = vi.fn();
  await nodeHandlers["node.pending.ack"]({
    client: createNodeClient(nodeId, commands) as never,
    context: {} as never,
    isWebchatConnect: () => false,
    params: { ids },
    req: { id: "req-node-pending-ack", method: "node.pending.ack", type: "req" },
    respond: respond as never,
  });
  return respond;
}

describe("node.invoke APNs wake path", () => {
  beforeEach(() => {
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveNodeCommandAllowlist.mockClear();
    mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set());
    mocks.isNodeCommandAllowed.mockClear();
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.sanitizeNodeInvokeParamsForForwarding.mockClear();
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementation(
      ({ rawParams }: { rawParams: unknown }) => ({ ok: true, params: rawParams }),
    );
    mocks.loadApnsRegistration.mockClear();
    mocks.clearApnsRegistrationIfCurrent.mockClear();
    mocks.resolveApnsAuthConfigFromEnv.mockClear();
    mocks.resolveApnsRelayConfigFromEnv.mockClear();
    mocks.sendApnsBackgroundWake.mockClear();
    mocks.sendApnsAlert.mockClear();
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the existing not-connected response when wake path is unavailable", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const respond = await invokeNode({ nodeRegistry });
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call?.[2]?.message).toBe("node not connected");
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("does not throttle repeated relay wake attempts when relay config is missing", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(relayRegistration("ios-node-relay-no-auth"));
    mocks.resolveApnsRelayConfigFromEnv.mockReturnValue({
      error: "relay config missing",
      ok: false,
    });

    const first = await maybeWakeNodeWithApns("ios-node-relay-no-auth");
    const second = await maybeWakeNodeWithApns("ios-node-relay-no-auth");

    expect(first).toMatchObject({
      apnsReason: "relay config missing",
      available: false,
      path: "no-auth",
      throttled: false,
    });
    expect(second).toMatchObject({
      apnsReason: "relay config missing",
      available: false,
      path: "no-auth",
      throttled: false,
    });
    expect(mocks.resolveApnsRelayConfigFromEnv).toHaveBeenCalledTimes(2);
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
  });

  it("wakes and retries invoke after the node reconnects", async () => {
    vi.useFakeTimers();
    mockDirectWakeConfig("ios-node-reconnect");

    let connected = false;
    const session: TestNodeSession = { commands: ["camera.capture"], nodeId: "ios-node-reconnect" };
    const nodeRegistry = {
      get: vi.fn((nodeId: string) => {
        if (nodeId !== "ios-node-reconnect") {
          return undefined;
        }
        return connected ? session : undefined;
      }),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payload: { ok: true },
        payloadJSON: '{"ok":true}',
      }),
    };

    const invokePromise = invokeNode({
      nodeRegistry,
      requestParams: { idempotencyKey: "idem-reconnect", nodeId: "ios-node-reconnect" },
    });
    setTimeout(() => {
      connected = true;
    }, 300);

    await vi.advanceTimersByTimeAsync(WAKE_WAIT_TIMEOUT_MS);
    const respond = await invokePromise;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(1);
    expect(nodeRegistry.invoke).toHaveBeenCalledTimes(1);
    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "camera.capture",
        nodeId: "ios-node-reconnect",
      }),
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ nodeId: "ios-node-reconnect", ok: true });
  });

  it("clears stale registrations after an invalid device token wake failure", async () => {
    const registration = directRegistration("ios-node-stale");
    mocks.loadApnsRegistration.mockResolvedValue(registration);
    mockDirectWakeConfig("ios-node-stale", {
      ok: false,
      reason: "BadDeviceToken",
      status: 400,
    });
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(true);
    const wake = await maybeWakeNodeWithApns("ios-node-stale", { force: true });

    expect(wake).toMatchObject({
      apnsReason: "BadDeviceToken",
      apnsStatus: 400,
      available: true,
      path: "send-error",
      throttled: false,
    });
    expect(mocks.clearApnsRegistrationIfCurrent).toHaveBeenCalledWith({
      nodeId: "ios-node-stale",
      registration,
    });
  });

  it("does not clear relay registrations from wake failures", async () => {
    const registration = relayRegistration("ios-node-relay");
    mockRelayWakeConfig("ios-node-relay", {
      ok: false,
      reason: "Unregistered",
      status: 410,
    });
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(false);
    const wake = await maybeWakeNodeWithApns("ios-node-relay", { force: true });

    expect(wake).toMatchObject({
      apnsReason: "Unregistered",
      apnsStatus: 410,
      available: true,
      path: "send-error",
      throttled: false,
    });
    expect(mocks.resolveApnsRelayConfigFromEnv).toHaveBeenCalledWith(process.env, {
      push: {
        apns: {
          relay: DEFAULT_RELAY_CONFIG,
        },
      },
    });
    expect(mocks.shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
      registration,
      result: {
        environment: "production",
        ok: false,
        reason: "Unregistered",
        status: 410,
        tokenSuffix: "abcd1234",
        topic: "ai.openclaw.ios",
        transport: "relay",
      },
    });
    expect(mocks.clearApnsRegistrationIfCurrent).not.toHaveBeenCalled();
  });

  it("forces one retry wake when the first wake still fails to reconnect", async () => {
    vi.useFakeTimers();
    mockDirectWakeConfig("ios-node-throttle");

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const invokePromise = invokeNode({
      nodeRegistry,
      requestParams: { idempotencyKey: "idem-throttle-1", nodeId: "ios-node-throttle" },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await invokePromise;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(2);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("queues iOS foreground-only command failures and keeps them until acked", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => ({
        commands: ["canvas.navigate"],
        nodeId: "ios-node-queued",
        platform: "iOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
        ok: false,
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "canvas.navigate",
        idempotencyKey: "idem-queued",
        nodeId: "ios-node-queued",
        params: { url: "http://example.com/" },
      },
    });
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call?.[2]?.message).toBe("node command queued until iOS returns to foreground");
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();

    const pullRespond = await pullPending("ios-node-queued", ["canvas.navigate"]);
    const pullCall = pullRespond.mock.calls[0] as RespondCall | undefined;
    expect(pullCall?.[0]).toBe(true);
    expect(pullCall?.[1]).toMatchObject({
      actions: [
        expect.objectContaining({
          command: "canvas.navigate",
          paramsJSON: JSON.stringify({ url: "http://example.com/" }),
        }),
      ],
      nodeId: "ios-node-queued",
    });

    const repeatedPullRespond = await pullPending("ios-node-queued", ["canvas.navigate"]);
    const repeatedPullCall = repeatedPullRespond.mock.calls[0] as RespondCall | undefined;
    expect(repeatedPullCall?.[0]).toBe(true);
    expect(repeatedPullCall?.[1]).toMatchObject({
      actions: [
        expect.objectContaining({
          command: "canvas.navigate",
          paramsJSON: JSON.stringify({ url: "http://example.com/" }),
        }),
      ],
      nodeId: "ios-node-queued",
    });

    const queuedActionId = (pullCall?.[1] as { actions?: { id?: string }[] } | undefined)
      ?.actions?.[0]?.id;
    expect(queuedActionId).toBeTruthy();

    const ackRespond = await ackPending("ios-node-queued", [queuedActionId!], ["canvas.navigate"]);
    const ackCall = ackRespond.mock.calls[0] as RespondCall | undefined;
    expect(ackCall?.[0]).toBe(true);
    expect(ackCall?.[1]).toMatchObject({
      ackedIds: [queuedActionId],
      nodeId: "ios-node-queued",
      remainingCount: 0,
    });

    const emptyPullRespond = await pullPending("ios-node-queued", ["canvas.navigate"]);
    const emptyPullCall = emptyPullRespond.mock.calls[0] as RespondCall | undefined;
    expect(emptyPullCall?.[0]).toBe(true);
    expect(emptyPullCall?.[1]).toMatchObject({
      actions: [],
      nodeId: "ios-node-queued",
    });
  });

  it("drops queued actions that are no longer allowed at pull time", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);
    const allowlistedCommands = new Set(["camera.snap", "canvas.navigate"]);
    mocks.resolveNodeCommandAllowlist.mockImplementation(() => new Set(allowlistedCommands));
    mocks.isNodeCommandAllowed.mockImplementation(
      ({ command, declaredCommands, allowlist }: MockNodeCommandPolicyParams) => {
        if (!allowlist.has(command)) {
          return { ok: false, reason: "command not allowlisted" };
        }
        if (!declaredCommands?.includes(command)) {
          return { ok: false, reason: "command not declared by node" };
        }
        return { ok: true };
      },
    );

    const nodeRegistry = {
      get: vi.fn(() => ({
        commands: ["camera.snap", "canvas.navigate"],
        nodeId: "ios-node-policy",
        platform: "iOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
        ok: false,
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "camera.snap",
        idempotencyKey: "idem-policy",
        nodeId: "ios-node-policy",
        params: { facing: "front" },
      },
    });

    const preChangePullRespond = await pullPending("ios-node-policy", [
      "camera.snap",
      "canvas.navigate",
    ]);
    const preChangePullCall = preChangePullRespond.mock.calls[0] as RespondCall | undefined;
    expect(preChangePullCall?.[0]).toBe(true);
    expect(preChangePullCall?.[1]).toMatchObject({
      actions: [
        expect.objectContaining({
          command: "camera.snap",
          paramsJSON: JSON.stringify({ facing: "front" }),
        }),
      ],
      nodeId: "ios-node-policy",
    });

    allowlistedCommands.delete("camera.snap");

    const pullRespond = await pullPending("ios-node-policy", ["camera.snap", "canvas.navigate"]);
    const pullCall = pullRespond.mock.calls[0] as RespondCall | undefined;
    expect(pullCall?.[0]).toBe(true);
    expect(pullCall?.[1]).toMatchObject({
      actions: [],
      nodeId: "ios-node-policy",
    });
  });

  it("dedupes queued foreground actions by idempotency key", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => ({
        commands: ["canvas.navigate"],
        nodeId: "ios-node-dedupe",
        platform: "iPadOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
        ok: false,
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "canvas.navigate",
        idempotencyKey: "idem-dedupe",
        nodeId: "ios-node-dedupe",
        params: { url: "http://example.com/first" },
      },
    });
    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "canvas.navigate",
        idempotencyKey: "idem-dedupe",
        nodeId: "ios-node-dedupe",
        params: { url: "http://example.com/first" },
      },
    });

    const pullRespond = await pullPending("ios-node-dedupe", ["canvas.navigate"]);
    const pullCall = pullRespond.mock.calls[0] as RespondCall | undefined;
    expect(pullCall?.[0]).toBe(true);
    expect(pullCall?.[1]).toMatchObject({
      actions: [
        expect.objectContaining({
          command: "canvas.navigate",
          paramsJSON: JSON.stringify({ url: "http://example.com/first" }),
        }),
      ],
      nodeId: "ios-node-dedupe",
    });
    const actions = (pullCall?.[1] as { actions?: unknown[] } | undefined)?.actions ?? [];
    expect(actions).toHaveLength(1);
  });
});
