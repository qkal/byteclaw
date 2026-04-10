import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway device.pair.approve caller scope guard", () => {
  test("rejects approving device scopes above the caller session scopes", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issueOperatorToken({
      approvedScopes: ["operator.admin"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
      name: "approve-attacker",
      tokenScopes: ["operator.pairing"],
    });
    const pending = loadDeviceIdentity("approve-target");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestDevicePairing({
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
        deviceId: pending.identity.deviceId,
        publicKey: pending.publicKey,
        role: "operator",
        scopes: ["operator.admin"],
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        deviceIdentityPath: approver.identityPath,
        deviceToken: approver.token,
        scopes: ["operator.pairing"],
        skipDefaultAuth: true,
      });

      const approve = await rpcReq(pairingWs, "device.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("missing scope: operator.admin");

      const paired = await getPairedDevice(pending.identity.deviceId);
      expect(paired).toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
