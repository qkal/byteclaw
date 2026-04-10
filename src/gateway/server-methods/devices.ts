import {
  type DeviceAuthToken,
  type RotateDeviceTokenDenyReason,
  approveDevicePairing,
  formatDevicePairingForbiddenMessage,
  getPairedDevice,
  listApprovedPairedDeviceRoles,
  listDevicePairing,
  rejectDevicePairing,
  removePairedDevice,
  revokeDeviceToken,
  rotateDeviceToken,
  summarizeDeviceTokens,
} from "../../infra/device-pairing.js";
import { normalizeDeviceAuthScopes } from "../../shared/device-auth.js";
import { resolveMissingRequestedScope } from "../../shared/operator-scope-compat.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateDevicePairApproveParams,
  validateDevicePairListParams,
  validateDevicePairRejectParams,
  validateDevicePairRemoveParams,
  validateDeviceTokenRevokeParams,
  validateDeviceTokenRotateParams,
} from "../protocol/index.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";

const DEVICE_TOKEN_ROTATION_DENIED_MESSAGE = "device token rotation denied";

interface DeviceTokenRotateTarget {
  pairedDevice: NonNullable<Awaited<ReturnType<typeof getPairedDevice>>>;
  normalizedRole: string;
}

interface DeviceManagementAuthz {
  callerDeviceId: string | null;
  callerScopes: string[];
  isAdminCaller: boolean;
  normalizedTargetDeviceId: string;
}

function redactPairedDevice(
  device: { tokens?: Record<string, DeviceAuthToken> } & Record<string, unknown>,
) {
  const { tokens, approvedScopes: _approvedScopes, ...rest } = device;
  return {
    ...rest,
    tokens: summarizeDeviceTokens(tokens),
  };
}

function logDeviceTokenRotationDenied(params: {
  log: { warn: (message: string) => void };
  deviceId: string;
  role: string;
  reason:
    | RotateDeviceTokenDenyReason
    | "caller-missing-scope"
    | "unknown-device-or-role"
    | "device-ownership-mismatch";
  scope?: string | null;
}) {
  const suffix = params.scope ? ` scope=${params.scope}` : "";
  params.log.warn(
    `device token rotation denied device=${params.deviceId} role=${params.role} reason=${params.reason}${suffix}`,
  );
}

async function loadDeviceTokenRotateTarget(params: {
  deviceId: string;
  role: string;
  log: { warn: (message: string) => void };
}): Promise<DeviceTokenRotateTarget | null> {
  const normalizedRole = params.role.trim();
  const pairedDevice = await getPairedDevice(params.deviceId);
  if (!pairedDevice || !listApprovedPairedDeviceRoles(pairedDevice).includes(normalizedRole)) {
    logDeviceTokenRotationDenied({
      deviceId: params.deviceId,
      log: params.log,
      reason: "unknown-device-or-role",
      role: params.role,
    });
    return null;
  }
  return { normalizedRole, pairedDevice };
}

function resolveDeviceManagementAuthz(
  client: GatewayClient | null,
  targetDeviceId: string,
): DeviceManagementAuthz {
  const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const rawCallerDeviceId = client?.connect?.device?.id;
  const callerDeviceId =
    typeof rawCallerDeviceId === "string" && rawCallerDeviceId.trim()
      ? rawCallerDeviceId.trim()
      : null;
  return {
    callerDeviceId,
    callerScopes,
    isAdminCaller: callerScopes.includes("operator.admin"),
    normalizedTargetDeviceId: targetDeviceId.trim(),
  };
}

function deniesCrossDeviceManagement(authz: DeviceManagementAuthz): boolean {
  return Boolean(
    authz.callerDeviceId &&
    authz.callerDeviceId !== authz.normalizedTargetDeviceId &&
    !authz.isAdminCaller,
  );
}

export const deviceHandlers: GatewayRequestHandlers = {
  "device.pair.approve": async ({ params, respond, context, client }) => {
    if (!validateDevicePairApproveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.approve params: ${formatValidationErrors(
            validateDevicePairApproveParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { requestId } = params as { requestId: string };
    const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const approved = await approveDevicePairing(requestId, { callerScopes });
    if (!approved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
    if (approved.status === "forbidden") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatDevicePairingForbiddenMessage(approved)),
      );
      return;
    }
    context.logGateway.info(
      `device pairing approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
    );
    context.broadcast(
      "device.pair.resolved",
      {
        decision: "approved",
        deviceId: approved.device.deviceId,
        requestId,
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
    respond(true, { device: redactPairedDevice(approved.device), requestId }, undefined);
  },
  "device.pair.list": async ({ params, respond }) => {
    if (!validateDevicePairListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.list params: ${formatValidationErrors(
            validateDevicePairListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const list = await listDevicePairing();
    respond(
      true,
      {
        paired: list.paired.map((device) => redactPairedDevice(device)),
        pending: list.pending,
      },
      undefined,
    );
  },
  "device.pair.reject": async ({ params, respond, context }) => {
    if (!validateDevicePairRejectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.reject params: ${formatValidationErrors(
            validateDevicePairRejectParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { requestId } = params as { requestId: string };
    const rejected = await rejectDevicePairing(requestId);
    if (!rejected) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
    context.broadcast(
      "device.pair.resolved",
      {
        decision: "rejected",
        deviceId: rejected.deviceId,
        requestId,
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
    respond(true, rejected, undefined);
  },
  "device.pair.remove": async ({ params, respond, context, client }) => {
    if (!validateDevicePairRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.remove params: ${formatValidationErrors(
            validateDevicePairRemoveParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId } = params as { deviceId: string };
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesCrossDeviceManagement(authz)) {
      context.logGateway.warn(
        `device pairing removal denied device=${deviceId} reason=device-ownership-mismatch`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "device pairing removal denied"),
      );
      return;
    }
    const removed = await removePairedDevice(deviceId);
    if (!removed) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId"));
      return;
    }
    context.logGateway.info(`device pairing removed device=${removed.deviceId}`);
    respond(true, removed, undefined);
    queueMicrotask(() => {
      context.disconnectClientsForDevice?.(removed.deviceId);
    });
  },
  "device.token.revoke": async ({ params, respond, context, client }) => {
    if (!validateDeviceTokenRevokeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.token.revoke params: ${formatValidationErrors(
            validateDeviceTokenRevokeParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId, role } = params as { deviceId: string; role: string };
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesCrossDeviceManagement(authz)) {
      context.logGateway.warn(
        `device token revocation denied device=${deviceId} role=${role} reason=device-ownership-mismatch`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "device token revocation denied"),
      );
      return;
    }
    const entry = await revokeDeviceToken({ deviceId, role });
    if (!entry) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId/role"));
      return;
    }
    const normalizedDeviceId = deviceId.trim();
    context.logGateway.info(`device token revoked device=${normalizedDeviceId} role=${entry.role}`);
    respond(
      true,
      {
        deviceId: normalizedDeviceId,
        revokedAtMs: entry.revokedAtMs ?? Date.now(),
        role: entry.role,
      },
      undefined,
    );
    queueMicrotask(() => {
      context.disconnectClientsForDevice?.(normalizedDeviceId, { role: entry.role });
    });
  },
  "device.token.rotate": async ({ params, respond, context, client }) => {
    if (!validateDeviceTokenRotateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.token.rotate params: ${formatValidationErrors(
            validateDeviceTokenRotateParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId, role, scopes } = params as {
      deviceId: string;
      role: string;
      scopes?: string[];
    };
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesCrossDeviceManagement(authz)) {
      logDeviceTokenRotationDenied({
        deviceId,
        log: context.logGateway,
        reason: "device-ownership-mismatch",
        role,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const rotateTarget = await loadDeviceTokenRotateTarget({
      deviceId,
      log: context.logGateway,
      role,
    });
    if (!rotateTarget) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const { pairedDevice, normalizedRole } = rotateTarget;
    const requestedScopes = normalizeDeviceAuthScopes(
      scopes ?? pairedDevice.tokens?.[normalizedRole]?.scopes ?? pairedDevice.scopes,
    );
    const missingScope = resolveMissingRequestedScope({
      allowedScopes: authz.callerScopes,
      requestedScopes,
      role,
    });
    if (missingScope) {
      logDeviceTokenRotationDenied({
        deviceId,
        log: context.logGateway,
        reason: "caller-missing-scope",
        role,
        scope: missingScope,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const rotated = await rotateDeviceToken({ deviceId, role, scopes });
    if (!rotated.ok) {
      logDeviceTokenRotationDenied({
        deviceId,
        log: context.logGateway,
        reason: rotated.reason,
        role,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const { entry } = rotated;
    context.logGateway.info(
      `device token rotated device=${deviceId} role=${entry.role} scopes=${entry.scopes.join(",")}`,
    );
    respond(
      true,
      {
        deviceId,
        role: entry.role,
        rotatedAtMs: entry.rotatedAtMs ?? entry.createdAtMs,
        scopes: entry.scopes,
        token: entry.token,
      },
      undefined,
    );
    queueMicrotask(() => {
      context.disconnectClientsForDevice?.(deviceId.trim(), { role: entry.role });
    });
  },
};
