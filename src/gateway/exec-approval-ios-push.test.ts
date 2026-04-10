import { beforeEach, describe, expect, it, vi } from "vitest";

const listDevicePairingMock = vi.fn();
const loadApnsRegistrationMock = vi.fn();
const resolveApnsAuthConfigFromEnvMock = vi.fn();
const resolveApnsRelayConfigFromEnvMock = vi.fn();
const sendApnsExecApprovalAlertMock = vi.fn();
const sendApnsExecApprovalResolvedWakeMock = vi.fn();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ gateway: {} }),
}));

vi.mock("../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-pairing.js")>(
    "../infra/device-pairing.js",
  );
  return {
    ...actual,
    listDevicePairing: listDevicePairingMock,
  };
});

vi.mock("../infra/push-apns.js", () => ({
  clearApnsRegistrationIfCurrent: vi.fn(),
  loadApnsRegistration: loadApnsRegistrationMock,
  resolveApnsAuthConfigFromEnv: resolveApnsAuthConfigFromEnvMock,
  resolveApnsRelayConfigFromEnv: resolveApnsRelayConfigFromEnvMock,
  sendApnsExecApprovalAlert: sendApnsExecApprovalAlertMock,
  sendApnsExecApprovalResolvedWake: sendApnsExecApprovalResolvedWakeMock,
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

describe("createExecApprovalIosPushDelivery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ paired: [], pending: [] });
    loadApnsRegistrationMock.mockResolvedValue({
      environment: "sandbox",
      nodeId: "ios-device-1",
      token: "apns-token",
      topic: "ai.openclaw.ios.test",
      transport: "direct",
      updatedAtMs: 1,
    });
    resolveApnsAuthConfigFromEnvMock.mockResolvedValue({
      ok: true,
      value: { keyId: "key", privateKey: "private-key", teamId: "team" },
    });
    resolveApnsRelayConfigFromEnvMock.mockReturnValue({ error: "unused", ok: false });
    sendApnsExecApprovalAlertMock.mockResolvedValue({
      environment: "sandbox",
      ok: true,
      status: 200,
      tokenSuffix: "token",
      topic: "ai.openclaw.ios.test",
      transport: "direct",
    });
    sendApnsExecApprovalResolvedWakeMock.mockResolvedValue({
      environment: "sandbox",
      ok: true,
      status: 200,
      tokenSuffix: "token",
      topic: "ai.openclaw.ios.test",
      transport: "direct",
    });
  });

  it("does not target iOS devices whose active operator token lacks operator.approvals", async () => {
    listDevicePairingMock.mockResolvedValue({
      paired: [
        {
          approvedAtMs: 1,
          approvedScopes: ["operator.approvals"],
          createdAtMs: 1,
          deviceId: "ios-device-1",
          platform: "iOS 18",
          publicKey: "pub",
          role: "operator",
          roles: ["operator"],
          tokens: {
            operator: {
              createdAtMs: 1,
              role: "operator",
              scopes: ["operator.read"],
              token: "operator-token",
            },
          },
        },
      ],
      pending: [],
    });

    const { createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js");
    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const accepted = await delivery.handleRequested({
      createdAtMs: 1,
      expiresAtMs: 2,
      id: "approval-1",
      request: { allowedDecisions: ["allow-once"], command: "echo ok", host: "gateway" },
    });

    expect(accepted).toBe(false);
    expect(loadApnsRegistrationMock).not.toHaveBeenCalled();
    expect(sendApnsExecApprovalAlertMock).not.toHaveBeenCalled();
  });

  it("targets iOS devices when the active operator token includes operator.approvals", async () => {
    listDevicePairingMock.mockResolvedValue({
      paired: [
        {
          approvedAtMs: 1,
          createdAtMs: 1,
          deviceId: "ios-device-1",
          platform: "iOS 18",
          publicKey: "pub",
          role: "operator",
          roles: ["operator"],
          tokens: {
            operator: {
              createdAtMs: 1,
              role: "operator",
              scopes: ["operator.approvals", "operator.read"],
              token: "operator-token",
            },
          },
        },
      ],
      pending: [],
    });

    const { createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js");
    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const accepted = await delivery.handleRequested({
      createdAtMs: 1,
      expiresAtMs: 2,
      id: "approval-2",
      request: { allowedDecisions: ["allow-once"], command: "echo ok", host: "gateway" },
    });

    expect(accepted).toBe(true);
    expect(loadApnsRegistrationMock).toHaveBeenCalledWith("ios-device-1");
    expect(sendApnsExecApprovalAlertMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat iOS as a live approval route when every push fails", async () => {
    const warn = vi.fn();
    listDevicePairingMock.mockResolvedValue({
      paired: [
        {
          approvedAtMs: 1,
          createdAtMs: 1,
          deviceId: "ios-device-1",
          platform: "iOS 18",
          publicKey: "pub",
          role: "operator",
          roles: ["operator"],
          tokens: {
            operator: {
              createdAtMs: 1,
              role: "operator",
              scopes: ["operator.approvals", "operator.read"],
              token: "operator-token",
            },
          },
        },
      ],
      pending: [],
    });
    sendApnsExecApprovalAlertMock.mockResolvedValue({
      environment: "sandbox",
      ok: false,
      reason: "Unregistered",
      status: 410,
      tokenSuffix: "token",
      topic: "ai.openclaw.ios.test",
      transport: "direct",
    });

    const { createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js");
    const delivery = createExecApprovalIosPushDelivery({ log: { warn } });

    const accepted = await delivery.handleRequested({
      createdAtMs: 1,
      expiresAtMs: 2,
      id: "approval-dead-route",
      request: { allowedDecisions: ["allow-once"], command: "echo ok", host: "gateway" },
    });

    expect(accepted).toBe(false);
    expect(sendApnsExecApprovalAlertMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "exec approvals: iOS request push failed node=ios-device-1 status=410 reason=Unregistered",
    );
    expect(warn).toHaveBeenCalledWith(
      "exec approvals: iOS request push reached no devices approvalId=approval-dead-route attempted=1",
    );
  });

  it("waits for request delivery to finish before sending cleanup pushes", async () => {
    listDevicePairingMock.mockResolvedValue({
      paired: [
        {
          approvedAtMs: 1,
          createdAtMs: 1,
          deviceId: "ios-device-1",
          platform: "iOS 18",
          publicKey: "pub",
          role: "operator",
          roles: ["operator"],
          tokens: {
            operator: {
              createdAtMs: 1,
              role: "operator",
              scopes: ["operator.approvals", "operator.read"],
              token: "operator-token",
            },
          },
        },
      ],
      pending: [],
    });
    const requestedPush = createDeferred<{
      ok: boolean;
      status: number;
      environment: string;
      topic: string;
      tokenSuffix: string;
      transport: string;
    }>();
    sendApnsExecApprovalAlertMock.mockReturnValue(requestedPush.promise);

    const { createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js");
    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const requested = delivery.handleRequested({
      createdAtMs: 1,
      expiresAtMs: 2,
      id: "approval-ordered-cleanup",
      request: { allowedDecisions: ["allow-once"], command: "echo ok", host: "gateway" },
    });
    const resolved = delivery.handleResolved({
      decision: "allow-once",
      id: "approval-ordered-cleanup",
      ts: 1,
    });

    await Promise.resolve();
    expect(sendApnsExecApprovalResolvedWakeMock).not.toHaveBeenCalled();

    requestedPush.resolve({
      environment: "sandbox",
      ok: true,
      status: 200,
      tokenSuffix: "token",
      topic: "ai.openclaw.ios.test",
      transport: "direct",
    });
    await requested;
    await resolved;

    expect(sendApnsExecApprovalResolvedWakeMock).toHaveBeenCalledTimes(1);
  });

  it("skips cleanup pushes when the original request target set is unknown", async () => {
    const debug = vi.fn();
    const { createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js");
    const delivery = createExecApprovalIosPushDelivery({ log: { debug } });

    await delivery.handleResolved({
      decision: "allow-once",
      id: "approval-missing-targets",
      ts: 1,
    });

    expect(debug).toHaveBeenCalledWith(
      "exec approvals: iOS cleanup push skipped approvalId=approval-missing-targets reason=missing-targets",
    );
    expect(listDevicePairingMock).not.toHaveBeenCalled();
    expect(loadApnsRegistrationMock).not.toHaveBeenCalled();
    expect(sendApnsExecApprovalResolvedWakeMock).not.toHaveBeenCalled();
  });

  it("sends cleanup pushes only to the original request targets", async () => {
    listDevicePairingMock.mockResolvedValue({
      paired: [
        {
          approvedAtMs: 1,
          createdAtMs: 1,
          deviceId: "ios-device-1",
          platform: "iOS 18",
          publicKey: "pub",
          role: "operator",
          roles: ["operator"],
          tokens: {
            operator: {
              createdAtMs: 1,
              role: "operator",
              scopes: ["operator.approvals", "operator.read"],
              token: "operator-token",
            },
          },
        },
      ],
      pending: [],
    });

    const { createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js");
    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    await delivery.handleRequested({
      createdAtMs: 1,
      expiresAtMs: 2,
      id: "approval-cleanup",
      request: { allowedDecisions: ["allow-once"], command: "echo ok", host: "gateway" },
    });
    vi.clearAllMocks();
    loadApnsRegistrationMock.mockResolvedValue({
      environment: "sandbox",
      nodeId: "ios-device-1",
      token: "apns-token",
      topic: "ai.openclaw.ios.test",
      transport: "direct",
      updatedAtMs: 1,
    });
    resolveApnsAuthConfigFromEnvMock.mockResolvedValue({
      ok: true,
      value: { keyId: "key", privateKey: "private-key", teamId: "team" },
    });

    await delivery.handleResolved({
      decision: "allow-once",
      id: "approval-cleanup",
      ts: 1,
    });

    expect(listDevicePairingMock).not.toHaveBeenCalled();
    expect(loadApnsRegistrationMock).toHaveBeenCalledWith("ios-device-1");
    expect(sendApnsExecApprovalResolvedWakeMock).toHaveBeenCalledTimes(1);
  });
});
