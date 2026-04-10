import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendApnsAlert,
  sendApnsBackgroundWake,
  sendApnsExecApprovalAlert,
  sendApnsExecApprovalResolvedWake,
} from "./push-apns.js";

const testAuthPrivateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

function createDirectApnsSendFixture(params: {
  nodeId: string;
  environment: "sandbox" | "production";
  sendResult: { status: number; apnsId: string; body: string };
}) {
  return {
    auth: {
      keyId: "KEY123",
      privateKey: testAuthPrivateKey,
      teamId: "TEAM123",
    },
    registration: {
      environment: params.environment,
      nodeId: params.nodeId,
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      transport: "direct" as const,
      updatedAtMs: 1,
    },
    send: vi.fn().mockResolvedValue(params.sendResult),
  };
}

function createRelayApnsSendFixture(params: {
  nodeId: string;
  relayHandle?: string;
  tokenDebugSuffix?: string;
  sendResult: {
    ok: boolean;
    status: number;
    environment: "production";
    apnsId?: string;
    reason?: string;
    tokenSuffix?: string;
  };
}) {
  return {
    gatewayIdentity: {
      deviceId: "gateway-device-1",
      privateKeyPem: testAuthPrivateKey,
    },
    registration: {
      distribution: "official" as const,
      environment: "production" as const,
      installationId: "install-123",
      nodeId: params.nodeId,
      relayHandle: params.relayHandle ?? "relay-handle-12345678",
      sendGrant: "send-grant-123",
      tokenDebugSuffix: params.tokenDebugSuffix,
      topic: "ai.openclaw.ios",
      transport: "relay" as const,
      updatedAtMs: 1,
    },
    relayConfig: {
      baseUrl: "https://relay.openclaw.test",
      timeoutMs: 2500,
    },
    send: vi.fn().mockResolvedValue(params.sendResult),
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
});

describe("push APNs send semantics", () => {
  it("sends alert pushes with alert headers and payload", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      environment: "sandbox",
      nodeId: "ios-node-alert",
      sendResult: {
        apnsId: "apns-alert-id",
        body: "",
        status: 200,
      },
    });

    const result = await sendApnsAlert({
      auth,
      body: "Ping",
      nodeId: "ios-node-alert",
      registration,
      requestSender: send,
      title: "Wake",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("alert");
    expect(sent?.priority).toBe("10");
    expect(sent?.payload).toMatchObject({
      aps: {
        alert: { body: "Ping", title: "Wake" },
        sound: "default",
      },
      openclaw: {
        kind: "push.test",
        nodeId: "ios-node-alert",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.transport).toBe("direct");
  });

  it("sends background wake pushes with silent payload semantics", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      environment: "production",
      nodeId: "ios-node-wake",
      sendResult: {
        apnsId: "apns-wake-id",
        body: "",
        status: 200,
      },
    });

    const result = await sendApnsBackgroundWake({
      auth,
      nodeId: "ios-node-wake",
      registration,
      requestSender: send,
      wakeReason: "node.invoke",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("background");
    expect(sent?.priority).toBe("5");
    expect(sent?.payload).toMatchObject({
      aps: {
        "content-available": 1,
      },
      openclaw: {
        kind: "node.wake",
        nodeId: "ios-node-wake",
        reason: "node.invoke",
      },
    });
    const sentPayload = sent?.payload as { aps?: { alert?: unknown; sound?: unknown } } | undefined;
    const aps = sentPayload?.aps;
    expect(aps?.alert).toBeUndefined();
    expect(aps?.sound).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.environment).toBe("production");
    expect(result.transport).toBe("direct");
  });

  it("sends exec approval alert pushes with generic modal-only metadata", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      environment: "sandbox",
      nodeId: "ios-node-approval-alert",
      sendResult: {
        apnsId: "apns-approval-alert-id",
        body: "",
        status: 200,
      },
    });

    const result = await sendApnsExecApprovalAlert({
      approvalId: "approval-123",
      auth,
      nodeId: "ios-node-approval-alert",
      registration,
      requestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("alert");
    expect(sent?.payload).toMatchObject({
      aps: {
        alert: {
          body: "Open OpenClaw to review this request.",
          title: "Exec approval required",
        },
        category: "openclaw.exec-approval",
        "content-available": 1,
        sound: "default",
      },
      openclaw: {
        approvalId: "approval-123",
        kind: "exec.approval.requested",
      },
    });
    expect(sent?.payload).not.toMatchObject({
      openclaw: {
        agentId: expect.anything(),
        allowedDecisions: expect.anything(),
        commandText: expect.anything(),
        expiresAtMs: expect.anything(),
        host: expect.anything(),
        nodeId: expect.anything(),
      },
    });
    expect(result.ok).toBe(true);
    expect(result.transport).toBe("direct");
  });

  it("sends exec approval cleanup pushes as silent background notifications", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      environment: "sandbox",
      nodeId: "ios-node-approval-cleanup",
      sendResult: {
        apnsId: "apns-approval-cleanup-id",
        body: "",
        status: 200,
      },
    });

    const result = await sendApnsExecApprovalResolvedWake({
      approvalId: "approval-123",
      auth,
      nodeId: "ios-node-approval-cleanup",
      registration,
      requestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("background");
    expect(sent?.payload).toMatchObject({
      aps: {
        "content-available": 1,
      },
      openclaw: {
        approvalId: "approval-123",
        kind: "exec.approval.resolved",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.transport).toBe("direct");
  });

  it("parses direct send failures and clamps sub-second timeouts", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      environment: "sandbox",
      nodeId: "ios-node-direct-fail",
      sendResult: {
        apnsId: "apns-direct-fail-id",
        body: '{"reason":" BadDeviceToken "}',
        status: 400,
      },
    });

    const result = await sendApnsAlert({
      auth,
      body: "Ping",
      nodeId: "ios-node-direct-fail",
      registration,
      requestSender: send,
      timeoutMs: 50,
      title: "Wake",
    });

    expect(send.mock.calls[0]?.[0]?.timeoutMs).toBe(1000);
    expect(result).toMatchObject({
      apnsId: "apns-direct-fail-id",
      ok: false,
      reason: "BadDeviceToken",
      status: 400,
      tokenSuffix: "abcd1234",
      transport: "direct",
    });
  });

  it("fails closed before sending when direct registrations carry invalid topics", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      environment: "sandbox",
      nodeId: "ios-node-invalid-topic",
      sendResult: {
        apnsId: "unused",
        body: "",
        status: 200,
      },
    });

    await expect(
      sendApnsAlert({
        auth,
        body: "Ping",
        nodeId: "ios-node-invalid-topic",
        registration: { ...registration, topic: "   " },
        requestSender: send,
        title: "Wake",
      }),
    ).rejects.toThrow("topic required");

    expect(send).not.toHaveBeenCalled();
  });

  it("defaults background wake reason when not provided", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      environment: "sandbox",
      nodeId: "ios-node-wake-default-reason",
      sendResult: {
        apnsId: "apns-wake-default-reason-id",
        body: "",
        status: 200,
      },
    });

    await sendApnsBackgroundWake({
      auth,
      nodeId: "ios-node-wake-default-reason",
      registration,
      requestSender: send,
    });

    const sent = send.mock.calls[0]?.[0];
    expect(sent?.payload).toMatchObject({
      openclaw: {
        kind: "node.wake",
        nodeId: "ios-node-wake-default-reason",
        reason: "node.invoke",
      },
    });
  });

  it("sends relay alert pushes and falls back to the stored token debug suffix", async () => {
    const { send, registration, relayConfig, gatewayIdentity } = createRelayApnsSendFixture({
      nodeId: "ios-node-relay-alert",
      sendResult: {
        apnsId: "relay-alert-id",
        environment: "production",
        ok: true,
        status: 202,
      },
      tokenDebugSuffix: "deadbeef",
    });

    const result = await sendApnsAlert({
      body: "Ping",
      nodeId: "ios-node-relay-alert",
      registration,
      relayConfig,
      relayGatewayIdentity: gatewayIdentity,
      relayRequestSender: send,
      title: "Wake",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      gatewayDeviceId: "gateway-device-1",
      payload: {
        aps: {
          alert: { body: "Ping", title: "Wake" },
          sound: "default",
        },
      },
      priority: "10",
      pushType: "alert",
      relayConfig,
      relayHandle: "relay-handle-12345678",
      sendGrant: "send-grant-123",
    });
    expect(sent?.signature).toEqual(expect.any(String));
    expect(result).toMatchObject({
      apnsId: "relay-alert-id",
      environment: "production",
      ok: true,
      status: 202,
      tokenSuffix: "deadbeef",
      transport: "relay",
    });
  });

  it("sends relay background pushes and falls back to the relay handle suffix", async () => {
    const { send, registration, relayConfig, gatewayIdentity } = createRelayApnsSendFixture({
      nodeId: "ios-node-relay-wake",
      sendResult: {
        environment: "production",
        ok: false,
        reason: "TooManyRequests",
        status: 429,
      },
      tokenDebugSuffix: undefined,
    });

    const result = await sendApnsBackgroundWake({
      nodeId: "ios-node-relay-wake",
      registration,
      relayConfig,
      relayGatewayIdentity: gatewayIdentity,
      relayRequestSender: send,
      wakeReason: "queue.retry",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      gatewayDeviceId: "gateway-device-1",
      payload: {
        aps: { "content-available": 1 },
        openclaw: {
          kind: "node.wake",
          nodeId: "ios-node-relay-wake",
          reason: "queue.retry",
        },
      },
      priority: "5",
      pushType: "background",
      relayConfig,
      relayHandle: "relay-handle-12345678",
      sendGrant: "send-grant-123",
    });
    expect(result).toMatchObject({
      environment: "production",
      ok: false,
      reason: "TooManyRequests",
      status: 429,
      tokenSuffix: "12345678",
      transport: "relay",
    });
  });

  it("sends relay exec approval alerts with generic modal-only metadata", async () => {
    const { send, registration, relayConfig, gatewayIdentity } = createRelayApnsSendFixture({
      nodeId: "ios-node-relay-approval-alert",
      sendResult: {
        apnsId: "relay-approval-alert-id",
        environment: "production",
        ok: true,
        status: 202,
      },
    });

    const result = await sendApnsExecApprovalAlert({
      approvalId: "approval-relay-1",
      nodeId: "ios-node-relay-approval-alert",
      registration,
      relayConfig,
      relayGatewayIdentity: gatewayIdentity,
      relayRequestSender: send,
    });

    const sent = send.mock.calls[0]?.[0];
    expect(sent?.payload).toMatchObject({
      aps: {
        alert: {
          body: "Open OpenClaw to review this request.",
          title: "Exec approval required",
        },
        category: "openclaw.exec-approval",
        "content-available": 1,
      },
      openclaw: {
        approvalId: "approval-relay-1",
        kind: "exec.approval.requested",
      },
    });
    expect(sent?.payload).not.toMatchObject({
      openclaw: {
        allowedDecisions: expect.anything(),
        commandText: expect.anything(),
        expiresAtMs: expect.anything(),
        host: expect.anything(),
        nodeId: expect.anything(),
      },
    });
    expect(result).toMatchObject({
      environment: "production",
      ok: true,
      status: 202,
      transport: "relay",
    });
  });
});
