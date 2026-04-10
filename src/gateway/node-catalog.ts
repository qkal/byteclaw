import { type PairedDevice, hasEffectivePairedDeviceRole } from "../infra/device-pairing.js";
import type { NodePairingPairedNode } from "../infra/node-pairing.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { NodeSession } from "./node-registry.js";

export interface KnownNodeDevicePairingSource {
  nodeId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  remoteIp?: string;
  approvedAtMs?: number;
}

export interface KnownNodeApprovedSource {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  approvedAtMs?: number;
}

export interface KnownNodeEntry {
  nodeId: string;
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
  live?: NodeSession;
  effective: NodeListNode;
}

export interface KnownNodeCatalog {
  entriesById: Map<string, KnownNodeEntry>;
}

function uniqueSortedStrings(...items: (readonly string[] | undefined)[]): string[] {
  const values = new Set<string>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    for (const value of item) {
      const trimmed = value.trim();
      if (trimmed) {
        values.add(trimmed);
      }
    }
  }
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function buildDevicePairingSource(entry: PairedDevice): KnownNodeDevicePairingSource {
  return {
    approvedAtMs: entry.approvedAtMs,
    clientId: entry.clientId,
    clientMode: entry.clientMode,
    displayName: entry.displayName,
    nodeId: entry.deviceId,
    platform: entry.platform,
    remoteIp: entry.remoteIp,
  };
}

function buildApprovedNodeSource(entry: NodePairingPairedNode): KnownNodeApprovedSource {
  return {
    approvedAtMs: entry.approvedAtMs,
    caps: entry.caps ?? [],
    commands: entry.commands ?? [],
    coreVersion: entry.coreVersion,
    deviceFamily: entry.deviceFamily,
    displayName: entry.displayName,
    modelIdentifier: entry.modelIdentifier,
    nodeId: entry.nodeId,
    permissions: entry.permissions,
    platform: entry.platform,
    remoteIp: entry.remoteIp,
    uiVersion: entry.uiVersion,
    version: entry.version,
  };
}

function buildEffectiveKnownNode(entry: {
  nodeId: string;
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
  live?: NodeSession;
}): NodeListNode {
  const { nodeId, devicePairing, nodePairing, live } = entry;
  return {
    approvedAtMs: nodePairing?.approvedAtMs ?? devicePairing?.approvedAtMs,
    caps: live ? uniqueSortedStrings(live.caps) : uniqueSortedStrings(nodePairing?.caps),
    clientId: live?.clientId ?? devicePairing?.clientId,
    clientMode: live?.clientMode ?? devicePairing?.clientMode,
    commands: live
      ? uniqueSortedStrings(live.commands)
      : uniqueSortedStrings(nodePairing?.commands),
    connected: Boolean(live),
    connectedAtMs: live?.connectedAtMs,
    coreVersion: live?.coreVersion ?? nodePairing?.coreVersion,
    deviceFamily: live?.deviceFamily ?? nodePairing?.deviceFamily,
    displayName: live?.displayName ?? nodePairing?.displayName ?? devicePairing?.displayName,
    modelIdentifier: live?.modelIdentifier ?? nodePairing?.modelIdentifier,
    nodeId,
    paired: Boolean(devicePairing ?? nodePairing),
    pathEnv: live?.pathEnv,
    permissions: live?.permissions ?? nodePairing?.permissions,
    platform: live?.platform ?? nodePairing?.platform ?? devicePairing?.platform,
    remoteIp: live?.remoteIp ?? nodePairing?.remoteIp ?? devicePairing?.remoteIp,
    uiVersion: live?.uiVersion ?? nodePairing?.uiVersion,
    version: live?.version ?? nodePairing?.version,
  };
}

function compareKnownNodes(left: NodeListNode, right: NodeListNode): number {
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  const leftName = normalizeLowercaseStringOrEmpty(left.displayName ?? left.nodeId);
  const rightName = normalizeLowercaseStringOrEmpty(right.displayName ?? right.nodeId);
  if (leftName < rightName) {
    return -1;
  }
  if (leftName > rightName) {
    return 1;
  }
  return left.nodeId.localeCompare(right.nodeId);
}

export function createKnownNodeCatalog(params: {
  pairedDevices: readonly PairedDevice[];
  pairedNodes?: readonly NodePairingPairedNode[];
  connectedNodes: readonly NodeSession[];
}): KnownNodeCatalog {
  const devicePairingById = new Map(
    params.pairedDevices
      .filter((entry) => hasEffectivePairedDeviceRole(entry, "node"))
      .map((entry) => [entry.deviceId, buildDevicePairingSource(entry)]),
  );
  const nodePairingById = new Map(
    (params.pairedNodes ?? []).map((entry) => [entry.nodeId, buildApprovedNodeSource(entry)]),
  );
  const liveById = new Map(params.connectedNodes.map((entry) => [entry.nodeId, entry]));
  const nodeIds = new Set<string>([
    ...devicePairingById.keys(),
    ...nodePairingById.keys(),
    ...liveById.keys(),
  ]);
  const entriesById = new Map<string, KnownNodeEntry>();
  for (const nodeId of nodeIds) {
    const devicePairing = devicePairingById.get(nodeId);
    const nodePairing = nodePairingById.get(nodeId);
    const live = liveById.get(nodeId);
    entriesById.set(nodeId, {
      devicePairing,
      effective: buildEffectiveKnownNode({
        devicePairing,
        live,
        nodeId,
        nodePairing,
      }),
      live,
      nodeId,
      nodePairing,
    });
  }
  return { entriesById };
}

export function listKnownNodes(catalog: KnownNodeCatalog): NodeListNode[] {
  return [...catalog.entriesById.values()]
    .map((entry) => entry.effective)
    .toSorted(compareKnownNodes);
}

export function getKnownNodeEntry(
  catalog: KnownNodeCatalog,
  nodeId: string,
): KnownNodeEntry | null {
  return catalog.entriesById.get(nodeId) ?? null;
}

export function getKnownNode(catalog: KnownNodeCatalog, nodeId: string): NodeListNode | null {
  return getKnownNodeEntry(catalog, nodeId)?.effective ?? null;
}
