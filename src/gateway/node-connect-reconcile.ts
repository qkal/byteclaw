import type { OpenClawConfig } from "../config/config.js";
import type {
  NodePairingPairedNode,
  NodePairingPendingRequest,
  NodePairingRequestInput,
} from "../infra/node-pairing.js";
import {
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";
import type { ConnectParams } from "./protocol/index.js";

interface PendingNodePairingResult {
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
}

export interface NodeConnectPairingReconcileResult {
  nodeId: string;
  effectiveCommands: string[];
  pendingPairing?: PendingNodePairingResult;
}

function resolveApprovedReconnectCommands(params: {
  pairedCommands: readonly string[] | undefined;
  allowlist: Set<string>;
}) {
  return normalizeDeclaredNodeCommands({
    allowlist: params.allowlist,
    declaredCommands: Array.isArray(params.pairedCommands) ? params.pairedCommands : [],
  });
}

function buildNodePairingRequestInput(params: {
  nodeId: string;
  connectParams: ConnectParams;
  commands: string[];
  remoteIp?: string;
}): NodePairingRequestInput {
  return {
    caps: params.connectParams.caps,
    commands: params.commands,
    deviceFamily: params.connectParams.client.deviceFamily,
    displayName: params.connectParams.client.displayName,
    modelIdentifier: params.connectParams.client.modelIdentifier,
    nodeId: params.nodeId,
    platform: params.connectParams.client.platform,
    remoteIp: params.remoteIp,
    version: params.connectParams.client.version,
  };
}

export async function reconcileNodePairingOnConnect(params: {
  cfg: OpenClawConfig;
  connectParams: ConnectParams;
  pairedNode: NodePairingPairedNode | null;
  reportedClientIp?: string;
  requestPairing: (input: NodePairingRequestInput) => Promise<PendingNodePairingResult>;
}): Promise<NodeConnectPairingReconcileResult> {
  const nodeId = params.connectParams.device?.id ?? params.connectParams.client.id;
  const allowlist = resolveNodeCommandAllowlist(params.cfg, {
    deviceFamily: params.connectParams.client.deviceFamily,
    platform: params.connectParams.client.platform,
  });
  const declared = normalizeDeclaredNodeCommands({
    allowlist,
    declaredCommands: Array.isArray(params.connectParams.commands)
      ? params.connectParams.commands
      : [],
  });

  if (!params.pairedNode) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        commands: declared,
        connectParams: params.connectParams,
        nodeId,
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      effectiveCommands: declared,
      nodeId,
      pendingPairing,
    };
  }

  const approvedCommands = resolveApprovedReconnectCommands({
    allowlist,
    pairedCommands: params.pairedNode.commands,
  });
  const hasCommandUpgrade = declared.some((command) => !approvedCommands.includes(command));

  if (hasCommandUpgrade) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        commands: declared,
        connectParams: params.connectParams,
        nodeId,
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      effectiveCommands: approvedCommands,
      nodeId,
      pendingPairing,
    };
  }

  return {
    effectiveCommands: declared,
    nodeId,
  };
}
