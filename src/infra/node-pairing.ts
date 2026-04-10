import { randomUUID } from "node:crypto";
import { resolveMissingRequestedScope } from "../shared/operator-scope-compat.js";
import { normalizeArrayBackedTrimmedStringList } from "../shared/string-normalization.js";
import { type NodeApprovalScope, resolveNodePairApprovalScopes } from "./node-pairing-authz.js";
import {
  createAsyncLock,
  pruneExpiredPending,
  readJsonFile,
  reconcilePendingPairingRequests,
  resolvePairingPaths,
  writeJsonAtomic,
} from "./pairing-files.js";
import { rejectPendingPairingRequest } from "./pairing-pending.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

export interface NodeDeclaredSurface {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
}

export type NodeApprovedSurface = NodeDeclaredSurface;

export type NodePairingRequestInput = NodeDeclaredSurface & {
  silent?: boolean;
};

export type NodePairingPendingRequest = NodePairingRequestInput & {
  requestId: string;
  silent?: boolean;
  ts: number;
};

export type NodePairingPendingEntry = NodePairingPendingRequest & {
  requiredApproveScopes: NodeApprovalScope[];
};

export type NodePairingPairedNode = NodeApprovedSurface & {
  token: string;
  bins?: string[];
  createdAtMs: number;
  approvedAtMs: number;
  lastConnectedAtMs?: number;
};

export interface NodePairingList {
  pending: NodePairingPendingEntry[];
  paired: NodePairingPairedNode[];
}

interface NodePairingStateFile {
  pendingById: Record<string, NodePairingPendingRequest>;
  pairedByNodeId: Record<string, NodePairingPairedNode>;
}

const PENDING_TTL_MS = 5 * 60 * 1000;
const OPERATOR_ROLE = "operator";

const withLock = createAsyncLock();

function buildPendingNodePairingRequest(params: {
  requestId?: string;
  req: NodePairingRequestInput;
}): NodePairingPendingRequest {
  return {
    caps: normalizeArrayBackedTrimmedStringList(params.req.caps),
    commands: normalizeArrayBackedTrimmedStringList(params.req.commands),
    coreVersion: params.req.coreVersion,
    deviceFamily: params.req.deviceFamily,
    displayName: params.req.displayName,
    modelIdentifier: params.req.modelIdentifier,
    nodeId: params.req.nodeId,
    permissions: params.req.permissions,
    platform: params.req.platform,
    remoteIp: params.req.remoteIp,
    requestId: params.requestId ?? randomUUID(),
    silent: params.req.silent,
    ts: Date.now(),
    uiVersion: params.req.uiVersion,
    version: params.req.version,
  };
}

function refreshPendingNodePairingRequest(
  existing: NodePairingPendingRequest,
  incoming: NodePairingRequestInput,
): NodePairingPendingRequest {
  return {
    ...existing,
    displayName: incoming.displayName ?? existing.displayName,
    platform: incoming.platform ?? existing.platform,
    version: incoming.version ?? existing.version,
    coreVersion: incoming.coreVersion ?? existing.coreVersion,
    uiVersion: incoming.uiVersion ?? existing.uiVersion,
    deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
    modelIdentifier: incoming.modelIdentifier ?? existing.modelIdentifier,
    caps: normalizeArrayBackedTrimmedStringList(incoming.caps) ?? existing.caps,
    commands: normalizeArrayBackedTrimmedStringList(incoming.commands) ?? existing.commands,
    permissions: incoming.permissions ?? existing.permissions,
    remoteIp: incoming.remoteIp ?? existing.remoteIp,
    // Preserve interactive visibility if either request needs attention.
    silent: Boolean(existing.silent && incoming.silent),
    ts: Date.now(),
  };
}

function resolveNodeApprovalRequiredScopes(
  pending: NodePairingPendingRequest,
): NodeApprovalScope[] {
  const commands = Array.isArray(pending.commands) ? pending.commands : [];
  return resolveNodePairApprovalScopes(commands);
}

function toPendingNodePairingEntry(pending: NodePairingPendingRequest): NodePairingPendingEntry {
  return {
    ...pending,
    requiredApproveScopes: resolveNodeApprovalRequiredScopes(pending),
  };
}

interface ApprovedNodePairingResult { requestId: string; node: NodePairingPairedNode }
interface ForbiddenNodePairingResult { status: "forbidden"; missingScope: string }
type ApproveNodePairingResult = ApprovedNodePairingResult | ForbiddenNodePairingResult | null;

async function loadState(baseDir?: string): Promise<NodePairingStateFile> {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
  const [pending, paired] = await Promise.all([
    readJsonFile<Record<string, NodePairingPendingRequest>>(pendingPath),
    readJsonFile<Record<string, NodePairingPairedNode>>(pairedPath),
  ]);
  const state: NodePairingStateFile = {
    pairedByNodeId: paired ?? {},
    pendingById: pending ?? {},
  };
  pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
  return state;
}

async function persistState(state: NodePairingStateFile, baseDir?: string) {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
  await Promise.all([
    writeJsonAtomic(pendingPath, state.pendingById),
    writeJsonAtomic(pairedPath, state.pairedByNodeId),
  ]);
}

function normalizeNodeId(nodeId: string) {
  return nodeId.trim();
}

function newToken() {
  return generatePairingToken();
}

export async function listNodePairing(baseDir?: string): Promise<NodePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById)
    .toSorted((a, b) => b.ts - a.ts)
    .map(toPendingNodePairingEntry);
  const paired = Object.values(state.pairedByNodeId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { paired, pending };
}

export async function getPairedNode(
  nodeId: string,
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  const state = await loadState(baseDir);
  return state.pairedByNodeId[normalizeNodeId(nodeId)] ?? null;
}

export async function requestNodePairing(
  req: NodePairingRequestInput,
  baseDir?: string,
): Promise<{
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
}> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const nodeId = normalizeNodeId(req.nodeId);
    if (!nodeId) {
      throw new Error("nodeId required");
    }
    const pendingForNode = Object.values(state.pendingById)
      .filter((pending) => pending.nodeId === nodeId)
      .toSorted((left, right) => right.ts - left.ts);
    return await reconcilePendingPairingRequests({
      buildReplacement: ({ existing, incoming }) =>
        buildPendingNodePairingRequest({
          req: {
            ...incoming,
            silent: Boolean(
              incoming.silent && existing.every((pending) => pending.silent === true),
            ),
          },
        }),
      canRefreshSingle: () => true,
      existing: pendingForNode,
      incoming: {
        ...req,
        nodeId,
      },
      pendingById: state.pendingById,
      persist: async () => await persistState(state, baseDir),
      refreshSingle: (existing, incoming) => refreshPendingNodePairingRequest(existing, incoming),
    });
  });
}

export async function approveNodePairing(
  requestId: string,
  options: { callerScopes?: readonly string[] },
  baseDir?: string,
): Promise<ApproveNodePairingResult> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    const requiredScopes = resolveNodeApprovalRequiredScopes(pending);
    const missingScope = resolveMissingRequestedScope({
      allowedScopes: options.callerScopes ?? [],
      requestedScopes: requiredScopes,
      role: OPERATOR_ROLE,
    });
    if (missingScope) {
      return { missingScope, status: "forbidden" };
    }

    const now = Date.now();
    const existing = state.pairedByNodeId[pending.nodeId];
    const node: NodePairingPairedNode = {
      approvedAtMs: now,
      caps: pending.caps,
      commands: pending.commands,
      coreVersion: pending.coreVersion,
      createdAtMs: existing?.createdAtMs ?? now,
      deviceFamily: pending.deviceFamily,
      displayName: pending.displayName,
      modelIdentifier: pending.modelIdentifier,
      nodeId: pending.nodeId,
      permissions: pending.permissions,
      platform: pending.platform,
      remoteIp: pending.remoteIp,
      token: newToken(),
      uiVersion: pending.uiVersion,
      version: pending.version,
    };

    delete state.pendingById[requestId];
    state.pairedByNodeId[pending.nodeId] = node;
    await persistState(state, baseDir);
    return { node, requestId };
  });
}

export async function rejectNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; nodeId: string } | null> {
  return await withLock(async () => await rejectPendingPairingRequest<
      NodePairingPendingRequest,
      NodePairingStateFile,
      "nodeId"
    >({
      getId: (pending: NodePairingPendingRequest) => pending.nodeId,
      idKey: "nodeId",
      loadState: () => loadState(baseDir),
      persistState: (state) => persistState(state, baseDir),
      requestId,
    }));
}

export async function verifyNodeToken(
  nodeId: string,
  token: string,
  baseDir?: string,
): Promise<{ ok: boolean; node?: NodePairingPairedNode }> {
  const state = await loadState(baseDir);
  const normalized = normalizeNodeId(nodeId);
  const node = state.pairedByNodeId[normalized];
  if (!node) {
    return { ok: false };
  }
  return verifyPairingToken(token, node.token) ? { node, ok: true } : { ok: false };
}

export async function updatePairedNodeMetadata(
  nodeId: string,
  patch: Partial<Omit<NodePairingPairedNode, "nodeId" | "token" | "createdAtMs" | "approvedAtMs">>,
  baseDir?: string,
) {
  await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) {
      return;
    }

    const next: NodePairingPairedNode = {
      ...existing,
      bins: patch.bins ?? existing.bins,
      caps: patch.caps ?? existing.caps,
      commands: patch.commands ?? existing.commands,
      coreVersion: patch.coreVersion ?? existing.coreVersion,
      deviceFamily: patch.deviceFamily ?? existing.deviceFamily,
      displayName: patch.displayName ?? existing.displayName,
      lastConnectedAtMs: patch.lastConnectedAtMs ?? existing.lastConnectedAtMs,
      modelIdentifier: patch.modelIdentifier ?? existing.modelIdentifier,
      permissions: patch.permissions ?? existing.permissions,
      platform: patch.platform ?? existing.platform,
      remoteIp: patch.remoteIp ?? existing.remoteIp,
      uiVersion: patch.uiVersion ?? existing.uiVersion,
      version: patch.version ?? existing.version,
    };

    state.pairedByNodeId[normalized] = next;
    await persistState(state, baseDir);
  });
}

export async function renamePairedNode(
  nodeId: string,
  displayName: string,
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) {
      return null;
    }
    const trimmed = displayName.trim();
    if (!trimmed) {
      throw new Error("displayName required");
    }
    const next: NodePairingPairedNode = { ...existing, displayName: trimmed };
    state.pairedByNodeId[normalized] = next;
    await persistState(state, baseDir);
    return next;
  });
}
