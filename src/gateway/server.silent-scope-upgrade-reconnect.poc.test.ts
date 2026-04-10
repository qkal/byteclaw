import { describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import * as devicePairingModule from "../infra/device-pairing.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway silent scope-upgrade reconnect", () => {
  test("does not silently widen a read-scoped paired device to admin on shared-auth reconnect", async () => {
    const started = await startServerWithClient("secret");
    const paired = await issueOperatorToken({
      approvedScopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
      name: "silent-scope-upgrade-reconnect-poc",
    });

    let watcherWs: WebSocket | undefined;
    let sharedAuthReconnectWs: WebSocket | undefined;
    let postAttemptDeviceTokenWs: WebSocket | undefined;

    try {
      watcherWs = await openTrackedWs(started.port);
      await connectOk(watcherWs, { scopes: ["operator.admin"] });
      const requestedEvent = onceMessage(
        watcherWs,
        (obj) => obj.type === "event" && obj.event === "device.pair.requested",
      );
      sharedAuthReconnectWs = await openTrackedWs(started.port);
      const sharedAuthUpgradeAttempt = await connectReq(sharedAuthReconnectWs, {
        deviceIdentityPath: paired.identityPath,
        scopes: ["operator.admin"],
        token: "secret",
      });
      expect(sharedAuthUpgradeAttempt.ok).toBe(false);
      expect(sharedAuthUpgradeAttempt.error?.message).toBe("pairing required");

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending).toHaveLength(1);
      expect(
        (sharedAuthUpgradeAttempt.error?.details as { requestId?: unknown; code?: string })
          ?.requestId,
      ).toBe(pending.pending[0]?.requestId);
      const requested = (await requestedEvent) as {
        payload?: { requestId?: string; deviceId?: string; scopes?: string[] };
      };
      expect(requested.payload?.requestId).toBe(pending.pending[0]?.requestId);
      expect(requested.payload?.deviceId).toBe(paired.deviceId);
      expect(requested.payload?.scopes).toEqual(["operator.admin"]);

      const afterUpgradeAttempt = await getPairedDevice(paired.deviceId);
      expect(afterUpgradeAttempt?.approvedScopes).toEqual(["operator.read"]);
      expect(afterUpgradeAttempt?.tokens?.operator?.scopes).toEqual(["operator.read"]);
      expect(afterUpgradeAttempt?.tokens?.operator?.token).toBe(paired.token);

      postAttemptDeviceTokenWs = await openTrackedWs(started.port);
      const afterUpgrade = await connectReq(postAttemptDeviceTokenWs, {
        deviceIdentityPath: paired.identityPath,
        deviceToken: paired.token,
        scopes: ["operator.admin"],
        skipDefaultAuth: true,
      });
      expect(afterUpgrade.ok).toBe(false);
    } finally {
      watcherWs?.close();
      sharedAuthReconnectWs?.close();
      postAttemptDeviceTokenWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("does not let backend reconnect bypass the paired scope baseline", async () => {
    const started = await startServerWithClient("secret");
    const paired = await issueOperatorToken({
      approvedScopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientMode: GATEWAY_CLIENT_MODES.BACKEND,
      name: "backend-scope-upgrade-reconnect-poc",
    });

    let watcherWs: WebSocket | undefined;
    let backendReconnectWs: WebSocket | undefined;

    try {
      watcherWs = await openTrackedWs(started.port);
      await connectOk(watcherWs, { scopes: ["operator.admin"] });
      const requestedEvent = onceMessage(
        watcherWs,
        (obj) => obj.type === "event" && obj.event === "device.pair.requested",
      );

      backendReconnectWs = await openTrackedWs(started.port);
      const reconnectAttempt = await connectReq(backendReconnectWs, {
        client: {
          id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
          platform: "node",
          version: "1.0.0",
        },
        deviceIdentityPath: paired.identityPath,
        role: "operator",
        scopes: ["operator.admin"],
        token: "secret",
      });
      expect(reconnectAttempt.ok).toBe(false);
      expect(reconnectAttempt.error?.message).toBe("pairing required");

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending).toHaveLength(1);
      expect(
        (reconnectAttempt.error?.details as { requestId?: unknown; code?: string })?.requestId,
      ).toBe(pending.pending[0]?.requestId);

      const requested = (await requestedEvent) as {
        payload?: { requestId?: string; deviceId?: string; scopes?: string[] };
      };
      expect(requested.payload?.requestId).toBe(pending.pending[0]?.requestId);
      expect(requested.payload?.deviceId).toBe(paired.deviceId);
      expect(requested.payload?.scopes).toEqual(["operator.admin"]);

      const afterAttempt = await getPairedDevice(paired.deviceId);
      expect(afterAttempt?.approvedScopes).toEqual(["operator.read"]);
      expect(afterAttempt?.tokens?.operator?.scopes).toEqual(["operator.read"]);
      expect(afterAttempt?.tokens?.operator?.token).toBe(paired.token);
    } finally {
      watcherWs?.close();
      backendReconnectWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("accepts local silent reconnect when pairing was concurrently approved", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-reconnect-race");
    let ws: WebSocket | undefined;

    const approveOriginal = devicePairingModule.approveDevicePairing;
    let simulatedRace = false;
    const forwardApprove = async (requestId: string, optionsOrBaseDir?: unknown) => {
      if (optionsOrBaseDir && typeof optionsOrBaseDir === "object") {
        return await approveOriginal(
          requestId,
          optionsOrBaseDir as { callerScopes?: readonly string[] },
        );
      }
      return await approveOriginal(requestId);
    };
    const approveSpy = vi
      .spyOn(devicePairingModule, "approveDevicePairing")
      .mockImplementation(async (requestId: string, optionsOrBaseDir?: unknown) => {
        if (simulatedRace) {
          return await forwardApprove(requestId, optionsOrBaseDir);
        }
        simulatedRace = true;
        await forwardApprove(requestId, optionsOrBaseDir);
        return null;
      });

    try {
      ws = await openTrackedWs(started.port);
      const res = await connectReq(ws, {
        deviceIdentityPath: loaded.identityPath,
        token: "secret",
      });
      expect(res.ok).toBe(true);

      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired?.publicKey).toBe(loaded.publicKey);
      expect(paired?.tokens?.operator?.token).toBeTruthy();
    } finally {
      approveSpy.mockRestore();
      ws?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("does not rebroadcast a deleted silent pairing request after a concurrent rejection", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-reconnect-reject-race");
    let ws: WebSocket | undefined;

    const approveSpy = vi
      .spyOn(devicePairingModule, "approveDevicePairing")
      .mockImplementation(async (requestId: string) => {
        await devicePairingModule.rejectDevicePairing(requestId);
        return null;
      });

    try {
      await connectOk(started.ws, { device: null, scopes: ["operator.pairing"] });
      const requestedEvent = onceMessage(
        started.ws,
        (obj) => obj.type === "event" && obj.event === "device.pair.requested",
        300,
      )
        .then((event) => ({ event, ok: true as const }))
        .catch((error: unknown) => ({ error, ok: false as const }));

      ws = await openTrackedWs(started.port);
      const res = await connectReq(ws, {
        deviceIdentityPath: loaded.identityPath,
        token: "secret",
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("pairing required");
      expect(
        (res.error?.details as { requestId?: unknown; code?: string } | undefined)?.requestId,
      ).toBeUndefined();
      const requested = await requestedEvent;
      expect(requested.ok).toBe(false);
      if (requested.ok) {
        throw new Error("expected pairing request watcher to time out");
      }
      expect(requested.error).toBeInstanceOf(Error);
      expect((requested.error as Error).message).toContain("timeout");

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending).toEqual([]);
    } finally {
      approveSpy.mockRestore();
      ws?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("returns the replacement pending request id when a silent request is superseded", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-reconnect-supersede-race");
    let ws: WebSocket | undefined;
    let replacementRequestId = "";

    const approveSpy = vi
      .spyOn(devicePairingModule, "approveDevicePairing")
      .mockImplementation(async (_requestId: string) => {
        const replacement = await devicePairingModule.requestDevicePairing({
          clientId: GATEWAY_CLIENT_NAMES.TEST,
          clientMode: GATEWAY_CLIENT_MODES.TEST,
          deviceId: loaded.identity.deviceId,
          publicKey: loaded.publicKey,
          role: "operator",
          scopes: ["operator.read"],
          silent: false,
        });
        replacementRequestId = replacement.request.requestId;
        return null;
      });

    try {
      ws = await openTrackedWs(started.port);
      const res = await connectReq(ws, {
        deviceIdentityPath: loaded.identityPath,
        token: "secret",
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("pairing required");
      expect(replacementRequestId).toBeTruthy();
      expect(
        (res.error?.details as { requestId?: unknown; code?: string } | undefined)?.requestId,
      ).toBe(replacementRequestId);

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending.map((entry) => entry.requestId)).toContain(replacementRequestId);
    } finally {
      approveSpy.mockRestore();
      ws?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
