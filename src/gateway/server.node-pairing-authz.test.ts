import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { approveNodePairing, listNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type {
  loadDeviceIdentity} from "./device-authz.test-helpers.js";
import {
  issueOperatorToken,
  openTrackedWs,
  pairDeviceIdentity,
} from "./device-authz.test-helpers.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function connectNodeClient(params: {
  port: number;
  deviceIdentity: ReturnType<typeof loadDeviceIdentity>["identity"];
  commands: string[];
}) {
  return await connectGatewayClient({
    clientDisplayName: "node-command-pin",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientVersion: "1.0.0",
    commands: params.commands,
    deviceIdentity: params.deviceIdentity,
    mode: GATEWAY_CLIENT_MODES.NODE,
    platform: "darwin",
    role: "node",
    scopes: [],
    timeoutMessage: "timeout waiting for paired node to connect",
    token: "secret",
    url: `ws://127.0.0.1:${params.port}`,
  });
}

describe("gateway node pairing authorization", () => {
  test("requires operator.admin for exec-capable node pairing approvals", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issueOperatorToken({
      approvedScopes: ["operator.admin"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
      name: "node-pair-approve-pairing-only",
      tokenScopes: ["operator.pairing"],
    });

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestNodePairing({
        commands: ["system.run"],
        nodeId: "node-approve-target",
        platform: "darwin",
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        deviceIdentityPath: approver.identityPath,
        deviceToken: approver.token,
        scopes: ["operator.pairing"],
        skipDefaultAuth: true,
      });

      const approve = await rpcReq(pairingWs, "node.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("missing scope: operator.admin");

      await expect(
        import("../infra/node-pairing.js").then((m) => m.getPairedNode("node-approve-target")),
      ).resolves.toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("requires operator.pairing before node pairing approvals", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issueOperatorToken({
      approvedScopes: ["operator.admin"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
      name: "node-pair-approve-attacker",
      tokenScopes: ["operator.write"],
    });

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestNodePairing({
        commands: ["system.run"],
        nodeId: "node-approve-target",
        platform: "darwin",
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        deviceIdentityPath: approver.identityPath,
        deviceToken: approver.token,
        scopes: ["operator.write"],
        skipDefaultAuth: true,
      });

      const approve = await rpcReq(pairingWs, "node.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("missing scope: operator.pairing");

      await expect(
        import("../infra/node-pairing.js").then((m) => m.getPairedNode("node-approve-target")),
      ).resolves.toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("allows pairing-only operators to approve commandless node requests", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issueOperatorToken({
      approvedScopes: ["operator.admin"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
      name: "node-pair-approve-commandless",
      tokenScopes: ["operator.pairing"],
    });

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestNodePairing({
        nodeId: "node-approve-target",
        platform: "darwin",
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        deviceIdentityPath: approver.identityPath,
        deviceToken: approver.token,
        scopes: ["operator.pairing"],
        skipDefaultAuth: true,
      });

      const approve = await rpcReq<{
        requestId?: string;
        node?: { nodeId?: string };
      }>(pairingWs, "node.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(true);
      expect(approve.payload?.requestId).toBe(request.request.requestId);
      expect(approve.payload?.node?.nodeId).toBe("node-approve-target");

      await expect(
        import("../infra/node-pairing.js").then((m) => m.getPairedNode("node-approve-target")),
      ).resolves.toEqual(
        expect.objectContaining({
          nodeId: "node-approve-target",
        }),
      );
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("requests re-pairing when a paired node reconnects with upgraded commands", async () => {
    const started = await startServerWithClient("secret");
    const pairedNode = await pairDeviceIdentity({
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
      name: "node-command-pin",
      role: "node",
      scopes: [],
    });

    let controlWs: WebSocket | undefined;
    let firstClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      controlWs = await openTrackedWs(started.port);
      await connectOk(controlWs, { token: "secret" });

      firstClient = await connectNodeClient({
        commands: ["canvas.snapshot"],
        deviceIdentity: pairedNode.identity,
        port: started.port,
      });
      await firstClient.stopAndWait();

      const request = await requestNodePairing({
        commands: ["canvas.snapshot"],
        nodeId: pairedNode.identity.deviceId,
        platform: "darwin",
      });
      await approveNodePairing(request.request.requestId, {
        callerScopes: ["operator.pairing", "operator.write"],
      });

      nodeClient = await connectNodeClient({
        commands: ["canvas.snapshot", "system.run"],
        deviceIdentity: pairedNode.identity,
        port: started.port,
      });

      const deadline = Date.now() + 2000;
      let lastNodes: { nodeId: string; connected?: boolean; commands?: string[] }[] = [];
      while (Date.now() < deadline) {
        const list = await rpcReq<{
          nodes?: { nodeId: string; connected?: boolean; commands?: string[] }[];
        }>(controlWs, "node.list", {});
        lastNodes = list.payload?.nodes ?? [];
        const node = lastNodes.find(
          (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
        );
        if (
          JSON.stringify(node?.commands?.toSorted() ?? []) === JSON.stringify(["canvas.snapshot"])
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(
        lastNodes
          .find((entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected)
          ?.commands?.toSorted(),
        JSON.stringify(lastNodes),
      ).toEqual(["canvas.snapshot"]);

      await expect(listNodePairing()).resolves.toEqual(
        expect.objectContaining({
          pending: [
            expect.objectContaining({
              commands: ["canvas.snapshot", "system.run"],
              nodeId: pairedNode.identity.deviceId,
            }),
          ],
        }),
      );
    } finally {
      controlWs?.close();
      await firstClient?.stopAndWait();
      await nodeClient?.stopAndWait();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("requests re-pairing when a commandless paired node reconnects with system.run", async () => {
    const started = await startServerWithClient("secret");
    const pairedNode = await pairDeviceIdentity({
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
      name: "node-command-empty",
      role: "node",
      scopes: [],
    });

    let controlWs: WebSocket | undefined;
    let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      controlWs = await openTrackedWs(started.port);
      await connectOk(controlWs, { token: "secret" });

      const initialApproval = await requestNodePairing({
        nodeId: pairedNode.identity.deviceId,
        platform: "darwin",
      });
      await approveNodePairing(initialApproval.request.requestId, {
        callerScopes: ["operator.pairing"],
      });

      nodeClient = await connectNodeClient({
        commands: ["canvas.snapshot", "system.run"],
        deviceIdentity: pairedNode.identity,
        port: started.port,
      });

      const deadline = Date.now() + 2000;
      let lastNodes: { nodeId: string; connected?: boolean; commands?: string[] }[] = [];
      while (Date.now() < deadline) {
        const list = await rpcReq<{
          nodes?: { nodeId: string; connected?: boolean; commands?: string[] }[];
        }>(controlWs, "node.list", {});
        lastNodes = list.payload?.nodes ?? [];
        const node = lastNodes.find(
          (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
        );
        if (JSON.stringify(node?.commands?.toSorted() ?? []) === JSON.stringify([])) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const repairedNode = lastNodes.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
      );
      expect(repairedNode?.commands?.toSorted(), JSON.stringify(lastNodes)).toEqual([]);

      await expect(listNodePairing()).resolves.toEqual(
        expect.objectContaining({
          pending: [
            expect.objectContaining({
              commands: ["canvas.snapshot", "system.run"],
              nodeId: pairedNode.identity.deviceId,
            }),
          ],
        }),
      );
    } finally {
      controlWs?.close();
      await nodeClient?.stopAndWait();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
