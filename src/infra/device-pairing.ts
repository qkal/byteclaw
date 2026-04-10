import { randomUUID } from "node:crypto";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import {
  type DeviceBootstrapProfile,
  resolveBootstrapProfileScopesForRole,
} from "../shared/device-bootstrap-profile.js";
import {
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
  roleScopesAllow,
} from "../shared/operator-scope-compat.js";
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

export interface DevicePairingPendingRequest {
  requestId: string;
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
}

export interface DeviceAuthToken {
  token: string;
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
}

export interface DeviceAuthTokenSummary {
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
}

export type RotateDeviceTokenDenyReason =
  | "unknown-device-or-role"
  | "missing-approved-scope-baseline"
  | "scope-outside-approved-baseline";

export type RotateDeviceTokenResult =
  | { ok: true; entry: DeviceAuthToken }
  | { ok: false; reason: RotateDeviceTokenDenyReason };

export interface PairedDevice {
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  approvedScopes?: string[];
  remoteIp?: string;
  tokens?: Record<string, DeviceAuthToken>;
  createdAtMs: number;
  approvedAtMs: number;
}

export type PairedDeviceMetadataPatch = Pick<
  PairedDevice,
  "displayName" | "clientId" | "clientMode" | "remoteIp"
>;

export interface DevicePairingList {
  pending: DevicePairingPendingRequest[];
  paired: PairedDevice[];
}

export type DevicePairingForbiddenReason =
  | "caller-scopes-required"
  | "caller-missing-scope"
  | "scope-outside-requested-roles"
  | "bootstrap-role-not-allowed"
  | "bootstrap-scope-not-allowed";

export interface DevicePairingForbiddenResult {
  status: "forbidden";
  reason: DevicePairingForbiddenReason;
  scope?: string;
  role?: string;
}

export type ApproveDevicePairingResult =
  | { status: "approved"; requestId: string; device: PairedDevice }
  | DevicePairingForbiddenResult
  | null;

interface DevicePairingStateFile {
  pendingById: Record<string, DevicePairingPendingRequest>;
  pairedByDeviceId: Record<string, PairedDevice>;
}

const PENDING_TTL_MS = 5 * 60 * 1000;
const OPERATOR_ROLE = "operator";
const OPERATOR_SCOPE_PREFIX = "operator.";

const withLock = createAsyncLock();

export function formatDevicePairingForbiddenMessage(result: DevicePairingForbiddenResult): string {
  switch (result.reason) {
    case "caller-scopes-required": {
      return `missing scope: ${result.scope ?? "callerScopes-required"}`;
    }
    case "caller-missing-scope": {
      return `missing scope: ${result.scope ?? "unknown"}`;
    }
    case "scope-outside-requested-roles": {
      return `invalid scope for requested roles: ${result.scope ?? "unknown"}`;
    }
    case "bootstrap-role-not-allowed": {
      return `bootstrap profile does not allow role: ${result.role ?? "unknown"}`;
    }
    case "bootstrap-scope-not-allowed": {
      return `bootstrap profile does not allow scope: ${result.scope ?? "unknown"}`;
    }
  }
}

async function loadState(baseDir?: string): Promise<DevicePairingStateFile> {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
  const [pending, paired] = await Promise.all([
    readJsonFile<Record<string, DevicePairingPendingRequest>>(pendingPath),
    readJsonFile<Record<string, PairedDevice>>(pairedPath),
  ]);
  const state: DevicePairingStateFile = {
    pairedByDeviceId: paired ?? {},
    pendingById: pending ?? {},
  };
  pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
  return state;
}

async function persistState(state: DevicePairingStateFile, baseDir?: string) {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
  await Promise.all([
    writeJsonAtomic(pendingPath, state.pendingById),
    writeJsonAtomic(pairedPath, state.pairedByDeviceId),
  ]);
}

function normalizeDeviceId(deviceId: string) {
  return deviceId.trim();
}

function normalizeRole(role: string | undefined): string | null {
  const trimmed = role?.trim();
  return trimmed ? trimmed : null;
}

function mergeRoles(...items: (string | string[] | undefined)[]): string[] | undefined {
  const roles = new Set<string>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (Array.isArray(item)) {
      for (const role of item) {
        const trimmed = role.trim();
        if (trimmed) {
          roles.add(trimmed);
        }
      }
    } else {
      const trimmed = item.trim();
      if (trimmed) {
        roles.add(trimmed);
      }
    }
  }
  if (roles.size === 0) {
    return undefined;
  }
  return [...roles];
}

function listActiveTokenRoles(
  tokens: Record<string, DeviceAuthToken> | undefined,
): string[] | undefined {
  if (!tokens) {
    return undefined;
  }
  return mergeRoles(
    Object.values(tokens)
      .filter((entry) => !entry.revokedAtMs)
      .map((entry) => entry.role),
  );
}

export function listApprovedPairedDeviceRoles(
  device: Pick<PairedDevice, "role" | "roles">,
): string[] {
  // Approved roles come from the pairing record itself. This is the durable
  // Contract the owner approved, independent of any currently active tokens.
  return mergeRoles(device.roles, device.role) ?? [];
}

export function listEffectivePairedDeviceRoles(
  device: Pick<PairedDevice, "role" | "roles" | "tokens">,
): string[] {
  const activeTokenRoles = listActiveTokenRoles(device.tokens);
  if (activeTokenRoles && activeTokenRoles.length > 0) {
    // Effective roles are the active token roles, bounded by the approved
    // Pairing contract. A stray token entry must not grant new access.
    const approvedRoles = new Set(listApprovedPairedDeviceRoles(device));
    return activeTokenRoles.filter((role) => approvedRoles.has(role));
  }
  // Token entries are authoritative. Tokenless legacy records fail closed so
  // Sticky historical role fields cannot retain access after token migration.
  return [];
}

export function hasEffectivePairedDeviceRole(
  device: Pick<PairedDevice, "role" | "roles" | "tokens">,
  role: string,
): boolean {
  const normalized = normalizeRole(role);
  if (!normalized) {
    return false;
  }
  return listEffectivePairedDeviceRoles(device).includes(normalized);
}

function mergeScopes(...items: (string[] | undefined)[]): string[] | undefined {
  const scopes = new Set<string>();
  let sawExplicitScopeList = false;
  for (const item of items) {
    if (!item) {
      continue;
    }
    sawExplicitScopeList = true;
    for (const scope of item) {
      const trimmed = scope.trim();
      if (trimmed) {
        scopes.add(trimmed);
      }
    }
  }
  if (scopes.size === 0) {
    return sawExplicitScopeList ? [] : undefined;
  }
  return [...scopes];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  for (const value of left) {
    if (!rightSet.has(value)) {
      return false;
    }
  }
  return true;
}

function resolveRequestedRoles(input: { role?: string; roles?: string[] }): string[] {
  return mergeRoles(input.roles, input.role) ?? [];
}

function resolveRequestedScopes(input: { scopes?: string[] }): string[] {
  return normalizeDeviceAuthScopes(input.scopes);
}

function samePendingApprovalSnapshot(
  existing: DevicePairingPendingRequest,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
): boolean {
  if (existing.publicKey !== incoming.publicKey) {
    return false;
  }
  if (normalizeRole(existing.role) !== normalizeRole(incoming.role)) {
    return false;
  }
  if (
    !sameStringSet(resolveRequestedRoles(existing), resolveRequestedRoles(incoming)) ||
    !sameStringSet(resolveRequestedScopes(existing), resolveRequestedScopes(incoming))
  ) {
    return false;
  }
  return true;
}

function refreshPendingDevicePairingRequest(
  existing: DevicePairingPendingRequest,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  isRepair: boolean,
): DevicePairingPendingRequest {
  return {
    ...existing,
    publicKey: incoming.publicKey,
    displayName: incoming.displayName ?? existing.displayName,
    platform: incoming.platform ?? existing.platform,
    deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
    clientId: incoming.clientId ?? existing.clientId,
    clientMode: incoming.clientMode ?? existing.clientMode,
    remoteIp: incoming.remoteIp ?? existing.remoteIp,
    // If either request is interactive, keep the pending request visible for approval.
    silent: Boolean(existing.silent && incoming.silent),
    isRepair: existing.isRepair || isRepair,
    ts: Date.now(),
  };
}

function resolveSupersededPendingSilent(params: {
  existing: readonly DevicePairingPendingRequest[];
  incomingSilent: boolean | undefined;
}): boolean {
  return Boolean(
    params.incomingSilent && params.existing.every((pending) => pending.silent === true),
  );
}

function buildPendingDevicePairingRequest(params: {
  requestId?: string;
  deviceId: string;
  isRepair: boolean;
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">;
}): DevicePairingPendingRequest {
  const role = normalizeRole(params.req.role) ?? undefined;
  return {
    clientId: params.req.clientId,
    clientMode: params.req.clientMode,
    deviceFamily: params.req.deviceFamily,
    deviceId: params.deviceId,
    displayName: params.req.displayName,
    isRepair: params.isRepair,
    platform: params.req.platform,
    publicKey: params.req.publicKey,
    remoteIp: params.req.remoteIp,
    requestId: params.requestId ?? randomUUID(),
    role,
    roles: mergeRoles(params.req.roles, role),
    scopes: mergeScopes(params.req.scopes),
    silent: params.req.silent,
    ts: Date.now(),
  };
}

function newToken() {
  return generatePairingToken();
}

function getPairedDeviceFromState(
  state: DevicePairingStateFile,
  deviceId: string,
): PairedDevice | null {
  return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}

function cloneDeviceTokens(device: PairedDevice): Record<string, DeviceAuthToken> {
  return device.tokens ? { ...device.tokens } : {};
}

function buildDeviceAuthToken(params: {
  role: string;
  scopes: string[];
  existing?: DeviceAuthToken;
  now: number;
  rotatedAtMs?: number;
}): DeviceAuthToken {
  return {
    createdAtMs: params.existing?.createdAtMs ?? params.now,
    lastUsedAtMs: params.existing?.lastUsedAtMs,
    revokedAtMs: undefined,
    role: params.role,
    rotatedAtMs: params.rotatedAtMs,
    scopes: params.scopes,
    token: newToken(),
  };
}

function resolveRoleScopedDeviceTokenScopes(role: string, scopes: string[] | undefined): string[] {
  const normalized = normalizeDeviceAuthScopes(scopes);
  if (role === "operator") {
    return normalized.filter((scope) => scope.startsWith(OPERATOR_SCOPE_PREFIX));
  }
  return normalized.filter((scope) => !scope.startsWith(OPERATOR_SCOPE_PREFIX));
}

function resolveApprovedTokenScopes(params: {
  role: string;
  pending: DevicePairingPendingRequest;
  existingToken?: DeviceAuthToken;
  approvedScopes?: string[];
  existing?: PairedDevice;
}): string[] {
  const requestedScopes = resolveRoleScopedDeviceTokenScopes(params.role, params.pending.scopes);
  if (requestedScopes.length > 0) {
    return requestedScopes;
  }
  return resolveRoleScopedDeviceTokenScopes(
    params.role,
    params.existingToken?.scopes ??
      params.approvedScopes ??
      params.existing?.approvedScopes ??
      params.existing?.scopes,
  );
}

function resolveApprovedDeviceScopeBaseline(device: PairedDevice): string[] | null {
  const baseline = device.approvedScopes ?? device.scopes;
  if (!Array.isArray(baseline)) {
    return null;
  }
  return normalizeDeviceAuthScopes(baseline);
}

function scopesWithinApprovedDeviceBaseline(params: {
  role: string;
  scopes: readonly string[];
  approvedScopes: readonly string[] | null;
}): boolean {
  if (!params.approvedScopes) {
    return false;
  }
  return roleScopesAllow({
    allowedScopes: params.approvedScopes,
    requestedScopes: params.scopes,
    role: params.role,
  });
}

export async function listDevicePairing(baseDir?: string): Promise<DevicePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByDeviceId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { paired, pending };
}

export async function getPairedDevice(
  deviceId: string,
  baseDir?: string,
): Promise<PairedDevice | null> {
  const state = await loadState(baseDir);
  return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}

export async function getPendingDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<DevicePairingPendingRequest | null> {
  const state = await loadState(baseDir);
  return state.pendingById[requestId] ?? null;
}

export async function requestDevicePairing(
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  baseDir?: string,
): Promise<{
  status: "pending";
  request: DevicePairingPendingRequest;
  created: boolean;
}> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const deviceId = normalizeDeviceId(req.deviceId);
    if (!deviceId) {
      throw new Error("deviceId required");
    }
    const isRepair = Boolean(state.pairedByDeviceId[deviceId]);
    const pendingForDevice = Object.values(state.pendingById)
      .filter((pending) => pending.deviceId === deviceId)
      .toSorted((left, right) => right.ts - left.ts);
    return await reconcilePendingPairingRequests({
      buildReplacement: ({ existing, incoming }) => {
        const latestPending = existing[0];
        const mergedRoles = mergeRoles(
          ...existing.flatMap((pending) => [pending.roles, pending.role]),
          incoming.roles,
          incoming.role,
        );
        const mergedScopes = mergeScopes(
          ...existing.map((pending) => pending.scopes),
          incoming.scopes,
        );
        return buildPendingDevicePairingRequest({
          deviceId,
          isRepair,
          req: {
            ...incoming,
            role: normalizeRole(incoming.role) ?? latestPending?.role,
            roles: mergedRoles,
            scopes: mergedScopes,
            // Preserve interactive visibility when superseding pending requests:
            // If any previous pending request was interactive, keep this one interactive.
            silent: resolveSupersededPendingSilent({
              existing,
              incomingSilent: incoming.silent,
            }),
          },
        });
      },
      canRefreshSingle: (existing, incoming) => samePendingApprovalSnapshot(existing, incoming),
      existing: pendingForDevice,
      incoming: req,
      pendingById: state.pendingById,
      persist: async () => await persistState(state, baseDir),
      refreshSingle: (existing, incoming) =>
        refreshPendingDevicePairingRequest(existing, incoming, isRepair),
    });
  });
}

export async function approveDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveDevicePairing(
  requestId: string,
  options: { callerScopes?: readonly string[] },
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveDevicePairing(
  requestId: string,
  optionsOrBaseDir?: { callerScopes?: readonly string[] } | string,
  maybeBaseDir?: string,
): Promise<ApproveDevicePairingResult> {
  const options =
    typeof optionsOrBaseDir === "string" || optionsOrBaseDir === undefined
      ? undefined
      : optionsOrBaseDir;
  const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    const requestedRoles = mergeRoles(pending.roles, pending.role) ?? [];
    const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
    const roleMismatchScope = resolveScopeOutsideRequestedRoles({
      requestedRoles,
      requestedScopes,
    });
    if (roleMismatchScope) {
      return {
        reason: "scope-outside-requested-roles",
        scope: roleMismatchScope,
        status: "forbidden",
      };
    }
    const requestedOperatorScopes = requestedScopes.filter((scope) =>
      scope.startsWith(OPERATOR_SCOPE_PREFIX),
    );
    if (requestedOperatorScopes.length > 0) {
      if (!options?.callerScopes) {
        return {
          reason: "caller-scopes-required",
          scope: requestedOperatorScopes[0],
          status: "forbidden",
        };
      }
      const missingScope = resolveMissingRequestedScope({
        allowedScopes: options.callerScopes,
        requestedScopes: requestedOperatorScopes,
        role: OPERATOR_ROLE,
      });
      if (missingScope) {
        return { reason: "caller-missing-scope", scope: missingScope, status: "forbidden" };
      }
    }
    const now = Date.now();
    const existing = state.pairedByDeviceId[pending.deviceId];
    const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
    const approvedScopes = mergeScopes(
      existing?.approvedScopes ?? existing?.scopes,
      pending.scopes,
    );
    const tokens = existing?.tokens ? { ...existing.tokens } : {};
    for (const roleForToken of requestedRoles) {
      const existingToken = tokens[roleForToken];
      const nextScopes = resolveApprovedTokenScopes({
        approvedScopes,
        existing,
        existingToken,
        pending,
        role: roleForToken,
      });
      const now = Date.now();
      tokens[roleForToken] = {
        createdAtMs: existingToken?.createdAtMs ?? now,
        lastUsedAtMs: existingToken?.lastUsedAtMs,
        revokedAtMs: undefined,
        role: roleForToken,
        rotatedAtMs: existingToken ? now : undefined,
        scopes: nextScopes,
        token: newToken(),
      };
    }
    const device: PairedDevice = {
      approvedAtMs: now,
      approvedScopes,
      clientId: pending.clientId,
      clientMode: pending.clientMode,
      createdAtMs: existing?.createdAtMs ?? now,
      deviceFamily: pending.deviceFamily,
      deviceId: pending.deviceId,
      displayName: pending.displayName,
      platform: pending.platform,
      publicKey: pending.publicKey,
      remoteIp: pending.remoteIp,
      role: pending.role,
      roles,
      scopes: approvedScopes,
      tokens,
    };
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, baseDir);
    return { device, requestId, status: "approved" };
  });
}

export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  baseDir?: string,
): Promise<ApproveDevicePairingResult> {
  // QR bootstrap handoff is an explicit trust path: it can seed the bounded
  // Node/operator baseline from the verified bootstrap profile without routing
  // Operator scope approval through the generic interactive approval checker.
  const approvedRoles = mergeRoles(bootstrapProfile.roles) ?? [];
  const approvedScopes = normalizeDeviceAuthScopes([...bootstrapProfile.scopes]);
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    const requestedRoles = resolveRequestedRoles(pending);
    const missingRole = requestedRoles.find((role) => !approvedRoles.includes(role));
    if (missingRole) {
      return { reason: "bootstrap-role-not-allowed", role: missingRole, status: "forbidden" };
    }
    const requestedOperatorScopes = normalizeDeviceAuthScopes(pending.scopes).filter((scope) =>
      scope.startsWith(OPERATOR_SCOPE_PREFIX),
    );
    const missingScope = resolveMissingRequestedScope({
      allowedScopes: approvedScopes,
      requestedScopes: requestedOperatorScopes,
      role: OPERATOR_ROLE,
    });
    if (missingScope) {
      return { reason: "bootstrap-scope-not-allowed", scope: missingScope, status: "forbidden" };
    }

    const now = Date.now();
    const existing = state.pairedByDeviceId[pending.deviceId];
    const roles = mergeRoles(
      existing?.roles,
      existing?.role,
      pending.roles,
      pending.role,
      approvedRoles,
    );
    const nextApprovedScopes = mergeScopes(
      existing?.approvedScopes ?? existing?.scopes,
      pending.scopes,
      approvedScopes,
    );
    const tokens = existing?.tokens ? { ...existing.tokens } : {};
    for (const roleForToken of approvedRoles) {
      const existingToken = tokens[roleForToken];
      const tokenScopes =
        roleForToken === OPERATOR_ROLE
          ? resolveBootstrapProfileScopesForRole(roleForToken, approvedScopes)
          : [];
      tokens[roleForToken] = buildDeviceAuthToken({
        existing: existingToken,
        now,
        role: roleForToken,
        scopes: tokenScopes,
        ...(existingToken ? { rotatedAtMs: now } : {}),
      });
    }

    const device: PairedDevice = {
      approvedAtMs: now,
      approvedScopes: nextApprovedScopes,
      clientId: pending.clientId,
      clientMode: pending.clientMode,
      createdAtMs: existing?.createdAtMs ?? now,
      deviceFamily: pending.deviceFamily,
      deviceId: pending.deviceId,
      displayName: pending.displayName,
      platform: pending.platform,
      publicKey: pending.publicKey,
      remoteIp: pending.remoteIp,
      role: pending.role,
      roles,
      scopes: nextApprovedScopes,
      tokens,
    };
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, baseDir);
    return { device, requestId, status: "approved" };
  });
}

export async function rejectDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; deviceId: string } | null> {
  return await withLock(
    async () =>
      await rejectPendingPairingRequest<
        DevicePairingPendingRequest,
        DevicePairingStateFile,
        "deviceId"
      >({
        getId: (pending: DevicePairingPendingRequest) => pending.deviceId,
        idKey: "deviceId",
        loadState: () => loadState(baseDir),
        persistState: (state) => persistState(state, baseDir),
        requestId,
      }),
  );
}

export async function removePairedDevice(
  deviceId: string,
  baseDir?: string,
): Promise<{ deviceId: string } | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeDeviceId(deviceId);
    if (!normalized || !state.pairedByDeviceId[normalized]) {
      return null;
    }
    delete state.pairedByDeviceId[normalized];
    await persistState(state, baseDir);
    return { deviceId: normalized };
  });
}

export async function updatePairedDeviceMetadata(
  deviceId: string,
  patch: Partial<PairedDeviceMetadataPatch>,
  baseDir?: string,
): Promise<void> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const existing = state.pairedByDeviceId[normalizedDeviceId];
    if (!existing) {
      return;
    }
    const next = { ...existing };
    if ("displayName" in patch) {
      next.displayName = patch.displayName;
    }
    if ("clientId" in patch) {
      next.clientId = patch.clientId;
    }
    if ("clientMode" in patch) {
      next.clientMode = patch.clientMode;
    }
    if ("remoteIp" in patch) {
      next.remoteIp = patch.remoteIp;
    }
    state.pairedByDeviceId[normalizedDeviceId] = next;
    await persistState(state, baseDir);
  });
}

export function summarizeDeviceTokens(
  tokens: Record<string, DeviceAuthToken> | undefined,
): DeviceAuthTokenSummary[] | undefined {
  if (!tokens) {
    return undefined;
  }
  const summaries = Object.values(tokens)
    .map((token) => ({
      createdAtMs: token.createdAtMs,
      lastUsedAtMs: token.lastUsedAtMs,
      revokedAtMs: token.revokedAtMs,
      role: token.role,
      rotatedAtMs: token.rotatedAtMs,
      scopes: token.scopes,
    }))
    .toSorted((a, b) => a.role.localeCompare(b.role));
  return summaries.length > 0 ? summaries : undefined;
}

export async function verifyDeviceToken(params: {
  deviceId: string;
  token: string;
  role: string;
  scopes: string[];
  baseDir?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const device = getPairedDeviceFromState(state, params.deviceId);
    if (!device) {
      return { ok: false, reason: "device-not-paired" };
    }
    const role = normalizeRole(params.role);
    if (!role) {
      return { ok: false, reason: "role-missing" };
    }
    const entry = device.tokens?.[role];
    if (!entry) {
      return { ok: false, reason: "token-missing" };
    }
    if (entry.revokedAtMs) {
      return { ok: false, reason: "token-revoked" };
    }
    if (!verifyPairingToken(params.token, entry.token)) {
      return { ok: false, reason: "token-mismatch" };
    }
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (
      !scopesWithinApprovedDeviceBaseline({
        approvedScopes,
        role,
        scopes: entry.scopes,
      })
    ) {
      return { ok: false, reason: "scope-mismatch" };
    }
    const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
    if (!roleScopesAllow({ allowedScopes: entry.scopes, requestedScopes, role })) {
      return { ok: false, reason: "scope-mismatch" };
    }
    entry.lastUsedAtMs = Date.now();
    device.tokens ??= {};
    device.tokens[role] = entry;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir);
    return { ok: true };
  });
}

export async function ensureDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes: string[];
  baseDir?: string;
}): Promise<DeviceAuthToken | null> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
    const context = resolveDeviceTokenUpdateContext({
      deviceId: params.deviceId,
      role: params.role,
      state,
    });
    if (!context) {
      return null;
    }
    const { device, role, tokens, existing } = context;
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (
      !scopesWithinApprovedDeviceBaseline({
        approvedScopes,
        role,
        scopes: requestedScopes,
      })
    ) {
      return null;
    }
    if (existing && !existing.revokedAtMs) {
      const existingWithinApproved = scopesWithinApprovedDeviceBaseline({
        approvedScopes,
        role,
        scopes: existing.scopes,
      });
      if (
        existingWithinApproved &&
        roleScopesAllow({ allowedScopes: existing.scopes, requestedScopes, role })
      ) {
        return existing;
      }
    }
    const now = Date.now();
    const next = buildDeviceAuthToken({
      existing,
      now,
      role,
      rotatedAtMs: existing ? now : undefined,
      scopes: requestedScopes,
    });
    tokens[role] = next;
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir);
    return next;
  });
}

function resolveDeviceTokenUpdateContext(params: {
  state: DevicePairingStateFile;
  deviceId: string;
  role: string;
}): {
  device: PairedDevice;
  role: string;
  tokens: Record<string, DeviceAuthToken>;
  existing: DeviceAuthToken | undefined;
} | null {
  const device = getPairedDeviceFromState(params.state, params.deviceId);
  if (!device) {
    return null;
  }
  const role = normalizeRole(params.role);
  if (!role) {
    return null;
  }
  // Token issuance and rotation must stay inside the role set that pairing
  // Approval recorded for this device.
  if (!listApprovedPairedDeviceRoles(device).includes(role)) {
    return null;
  }
  const tokens = cloneDeviceTokens(device);
  const existing = tokens[role];
  return { device, existing, role, tokens };
}

export async function rotateDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes?: string[];
  baseDir?: string;
}): Promise<RotateDeviceTokenResult> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const context = resolveDeviceTokenUpdateContext({
      deviceId: params.deviceId,
      role: params.role,
      state,
    });
    if (!context) {
      return { ok: false, reason: "unknown-device-or-role" };
    }
    const { device, role, tokens, existing } = context;
    const requestedScopes = normalizeDeviceAuthScopes(
      params.scopes ?? existing?.scopes ?? device.scopes,
    );
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (!approvedScopes) {
      return { ok: false, reason: "missing-approved-scope-baseline" };
    }
    if (
      !scopesWithinApprovedDeviceBaseline({
        approvedScopes,
        role,
        scopes: requestedScopes,
      })
    ) {
      return { ok: false, reason: "scope-outside-approved-baseline" };
    }
    const now = Date.now();
    const next = buildDeviceAuthToken({
      existing,
      now,
      role,
      rotatedAtMs: now,
      scopes: requestedScopes,
    });
    tokens[role] = next;
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir);
    return { entry: next, ok: true };
  });
}

export async function revokeDeviceToken(params: {
  deviceId: string;
  role: string;
  baseDir?: string;
}): Promise<DeviceAuthToken | null> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const device = state.pairedByDeviceId[normalizeDeviceId(params.deviceId)];
    if (!device) {
      return null;
    }
    const role = normalizeRole(params.role);
    if (!role) {
      return null;
    }
    if (!device.tokens?.[role]) {
      return null;
    }
    const tokens = { ...device.tokens };
    const entry = { ...tokens[role], revokedAtMs: Date.now() };
    tokens[role] = entry;
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir);
    return entry;
  });
}

export async function clearDevicePairing(deviceId: string, baseDir?: string): Promise<boolean> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalizedId = normalizeDeviceId(deviceId);
    if (!state.pairedByDeviceId[normalizedId]) {
      return false;
    }
    delete state.pairedByDeviceId[normalizedId];
    await persistState(state, baseDir);
    return true;
  });
}
