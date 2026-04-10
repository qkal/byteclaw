import type { IncomingMessage } from "node:http";
import os from "node:os";
import type { WebSocket } from "ws";
import { loadConfig } from "../../../config/config.js";
import {
  getBoundDeviceBootstrapProfile,
  getDeviceBootstrapTokenProfile,
  redeemDeviceBootstrapTokenProfile,
  revokeDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "../../../infra/device-bootstrap.js";
import {
  deriveDeviceIdFromPublicKey,
  normalizeDevicePublicKeyBase64Url,
} from "../../../infra/device-identity.js";
import {
  approveBootstrapDevicePairing,
  approveDevicePairing,
  ensureDeviceToken,
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  listDevicePairing,
  listEffectivePairedDeviceRoles,
  requestDevicePairing,
  updatePairedDeviceMetadata,
  verifyDeviceToken,
} from "../../../infra/device-pairing.js";
import {
  getPairedNode,
  requestNodePairing,
  updatePairedNodeMetadata,
} from "../../../infra/node-pairing.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../../../infra/skills-remote.js";
import { upsertPresence } from "../../../infra/system-presence.js";
import { loadVoiceWakeConfig } from "../../../infra/voicewake.js";
import { rawDataToString } from "../../../infra/ws.js";
import type { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  type DeviceBootstrapProfile,
  resolveBootstrapProfileScopesForRole,
} from "../../../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import {
  isBrowserOperatorUiClient,
  isGatewayCliClient,
  isOperatorUiClient,
  isWebchatClient,
} from "../../../utils/message-channel.js";
import { resolveRuntimeServiceVersion } from "../../../version.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "../../auth.js";
import { isLocalDirectRequest } from "../../auth.js";
import {
  CANVAS_CAPABILITY_TTL_MS,
  buildCanvasScopedHostUrl,
  mintCanvasCapabilityToken,
} from "../../canvas-capability.js";
import { normalizeDeviceMetadataForAuth } from "../../device-auth.js";
import { ADMIN_SCOPE } from "../../method-scopes.js";
import {
  isLocalishHost,
  isLoopbackAddress,
  isTrustedProxyAddress,
  resolveClientIp,
} from "../../net.js";
import { reconcileNodePairingOnConnect } from "../../node-connect-reconcile.js";
import { checkBrowserOrigin } from "../../origin-check.js";
import {
  ConnectErrorDetailCodes,
  resolveAuthConnectErrorDetailCode,
  resolveDeviceAuthConnectErrorDetailCode,
} from "../../protocol/connect-error-details.js";
import {
  type ConnectParams,
  ErrorCodes,
  type ErrorShape,
  PROTOCOL_VERSION,
  errorShape,
  formatValidationErrors,
  validateConnectParams,
  validateRequestFrame,
} from "../../protocol/index.js";
import { parseGatewayRole } from "../../role-policy.js";
import {
  MAX_BUFFERED_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PREAUTH_PAYLOAD_BYTES,
  TICK_INTERVAL_MS,
} from "../../server-constants.js";
import { handleGatewayRequest } from "../../server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { formatError } from "../../server-utils.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import {
  buildGatewaySnapshot,
  getHealthCache,
  getHealthVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "../health-state.js";
import { resolveSharedGatewaySessionGeneration } from "../ws-shared-generation.js";
import type { GatewayWsClient } from "../ws-types.js";
import { resolveConnectAuthDecision, resolveConnectAuthState } from "./auth-context.js";
import { formatGatewayAuthFailureMessage } from "./auth-messages.js";
import {
  evaluateMissingDeviceIdentity,
  isTrustedProxyControlUiOperatorAuth,
  resolveControlUiAuthPolicy,
  shouldClearUnboundScopesForMissingDeviceIdentity,
  shouldSkipControlUiPairing,
} from "./connect-policy.js";
import {
  resolveDeviceSignaturePayloadVersion,
  resolveHandshakeBrowserSecurityContext,
  resolvePairingLocality,
  resolveUnauthorizedHandshakeContext,
  shouldAllowSilentLocalPairing,
  shouldSkipLocalBackendSelfPairing,
} from "./handshake-auth-helpers.js";
import { UnauthorizedFloodGuard, isUnauthorizedRoleError } from "./unauthorized-flood-guard.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const DEVICE_SIGNATURE_SKEW_MS = 2 * 60 * 1000;

export interface WsOriginCheckMetrics {
  hostHeaderFallbackAccepted: number;
}

function resolvePinnedClientMetadata(params: {
  claimedPlatform?: string;
  claimedDeviceFamily?: string;
  pairedPlatform?: string;
  pairedDeviceFamily?: string;
}): {
  platformMismatch: boolean;
  deviceFamilyMismatch: boolean;
  pinnedPlatform?: string;
  pinnedDeviceFamily?: string;
} {
  const claimedPlatform = normalizeDeviceMetadataForAuth(params.claimedPlatform);
  const claimedDeviceFamily = normalizeDeviceMetadataForAuth(params.claimedDeviceFamily);
  const pairedPlatform = normalizeDeviceMetadataForAuth(params.pairedPlatform);
  const pairedDeviceFamily = normalizeDeviceMetadataForAuth(params.pairedDeviceFamily);
  const hasPinnedPlatform = pairedPlatform !== "";
  const hasPinnedDeviceFamily = pairedDeviceFamily !== "";
  const platformMismatch = hasPinnedPlatform && claimedPlatform !== pairedPlatform;
  const deviceFamilyMismatch = hasPinnedDeviceFamily && claimedDeviceFamily !== pairedDeviceFamily;
  return {
    deviceFamilyMismatch,
    pinnedDeviceFamily: hasPinnedDeviceFamily ? params.pairedDeviceFamily : undefined,
    pinnedPlatform: hasPinnedPlatform ? params.pairedPlatform : undefined,
    platformMismatch,
  };
}

export function attachGatewayWsMessageHandler(params: {
  socket: WebSocket;
  upgradeReq: IncomingMessage;
  connId: string;
  remoteAddr?: string;
  remotePort?: number;
  localAddr?: string;
  localPort?: number;
  endpoint?: string;
  forwardedFor?: string;
  realIp?: string;
  requestHost?: string;
  requestOrigin?: string;
  requestUserAgent?: string;
  canvasHostUrl?: string;
  connectNonce: string;
  getResolvedAuth: () => ResolvedGatewayAuth;
  getRequiredSharedGatewaySessionGeneration: () => string | undefined;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Browser-origin fallback limiter (loopback is never exempt). */
  browserRateLimiter?: AuthRateLimiter;
  gatewayMethods: string[];
  events: string[];
  extraHandlers: GatewayRequestHandlers;
  buildRequestContext: () => GatewayRequestContext;
  send: (obj: unknown) => void;
  close: (code?: number, reason?: string) => void;
  isClosed: () => boolean;
  clearHandshakeTimer: () => void;
  getClient: () => GatewayWsClient | null;
  setClient: (next: GatewayWsClient) => void;
  setHandshakeState: (state: "pending" | "connected" | "failed") => void;
  setCloseCause: (cause: string, meta?: Record<string, unknown>) => void;
  setLastFrameMeta: (meta: { type?: string; method?: string; id?: string }) => void;
  originCheckMetrics: WsOriginCheckMetrics;
  logGateway: SubsystemLogger;
  logHealth: SubsystemLogger;
  logWsControl: SubsystemLogger;
}) {
  const {
    socket,
    upgradeReq,
    connId,
    remoteAddr,
    remotePort,
    localAddr,
    localPort,
    endpoint,
    forwardedFor,
    realIp,
    requestHost,
    requestOrigin,
    requestUserAgent,
    canvasHostUrl,
    connectNonce,
    getResolvedAuth,
    getRequiredSharedGatewaySessionGeneration,
    rateLimiter,
    browserRateLimiter,
    gatewayMethods,
    events,
    extraHandlers,
    buildRequestContext,
    send,
    close,
    isClosed,
    clearHandshakeTimer,
    getClient,
    setClient,
    setHandshakeState,
    setCloseCause,
    setLastFrameMeta,
    originCheckMetrics,
    logGateway,
    logHealth,
    logWsControl,
  } = params;

  const sendFrame = async (obj: unknown): Promise<void> =>
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(obj), (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

  const configSnapshot = loadConfig();
  const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
  const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
  const clientIp = resolveClientIp({
    allowRealIpFallback,
    forwardedFor,
    realIp,
    remoteAddr,
    trustedProxies,
  });
  const peerLabel = endpoint ?? remoteAddr ?? "n/a";

  // If proxy headers are present but the remote address isn't trusted, don't treat
  // The connection as local. This prevents auth bypass when running behind a reverse
  // Proxy without proper configuration - the proxy's loopback connection would otherwise
  // Cause all external requests to be treated as trusted local clients.
  const hasProxyHeaders = Boolean(forwardedFor || realIp);
  const remoteIsTrustedProxy = isTrustedProxyAddress(remoteAddr, trustedProxies);
  const hasUntrustedProxyHeaders = hasProxyHeaders && !remoteIsTrustedProxy;
  const hostIsLocalish = isLocalishHost(requestHost);
  const isLocalClient = isLocalDirectRequest(upgradeReq, trustedProxies, allowRealIpFallback);

  const reportedClientIp =
    isLocalClient || hasUntrustedProxyHeaders
      ? undefined
      : (clientIp && !isLoopbackAddress(clientIp)
        ? clientIp
        : undefined);

  if (hasUntrustedProxyHeaders) {
    logWsControl.warn(
      "Proxy headers detected from untrusted address. " +
        "Connection will not be treated as local. " +
        "Configure gateway.trustedProxies to restore local client detection behind your proxy.",
    );
  }
  if (!hostIsLocalish && isLoopbackAddress(remoteAddr) && !hasProxyHeaders) {
    logWsControl.warn(
      "Loopback connection with non-local Host header. " +
        "Treating it as remote. If you're behind a reverse proxy, " +
        "set gateway.trustedProxies and forward X-Forwarded-For/X-Real-IP.",
    );
  }

  const isWebchatConnect = (p: ConnectParams | null | undefined) => isWebchatClient(p?.client);
  const unauthorizedFloodGuard = new UnauthorizedFloodGuard();
  const browserSecurity = resolveHandshakeBrowserSecurityContext({
    browserRateLimiter,
    clientIp,
    rateLimiter,
    requestOrigin,
  });
  const {
    hasBrowserOriginHeader,
    enforceOriginCheckForAnyClient,
    rateLimitClientIp: browserRateLimitClientIp,
    authRateLimiter,
  } = browserSecurity;

  socket.on("message", async (data) => {
    if (isClosed()) {
      return;
    }

    const preauthPayloadBytes = !getClient() ? getRawDataByteLength(data) : undefined;
    if (preauthPayloadBytes !== undefined && preauthPayloadBytes > MAX_PREAUTH_PAYLOAD_BYTES) {
      setHandshakeState("failed");
      setCloseCause("preauth-payload-too-large", {
        limitBytes: MAX_PREAUTH_PAYLOAD_BYTES,
        payloadBytes: preauthPayloadBytes,
      });
      close(1009, "preauth payload too large");
      return;
    }

    const text = rawDataToString(data);
    try {
      const parsed = JSON.parse(text);
      const frameType =
        parsed && typeof parsed === "object" && "type" in parsed
          ? (typeof (parsed as { type?: unknown }).type === "string"
            ? String((parsed as { type?: unknown }).type)
            : undefined)
          : undefined;
      const frameMethod =
        parsed && typeof parsed === "object" && "method" in parsed
          ? (typeof (parsed as { method?: unknown }).method === "string"
            ? String((parsed as { method?: unknown }).method)
            : undefined)
          : undefined;
      const frameId =
        parsed && typeof parsed === "object" && "id" in parsed
          ? (typeof (parsed as { id?: unknown }).id === "string"
            ? String((parsed as { id?: unknown }).id)
            : undefined)
          : undefined;
      if (frameType || frameMethod || frameId) {
        setLastFrameMeta({ id: frameId, method: frameMethod, type: frameType });
      }

      const client = getClient();
      if (!client) {
        // Handshake must be a normal request:
        // { type:"req", method:"connect", params: ConnectParams }.
        const isRequestFrame = validateRequestFrame(parsed);
        if (
          !isRequestFrame ||
          parsed.method !== "connect" ||
          !validateConnectParams(parsed.params)
        ) {
          const handshakeError = isRequestFrame
            ? (parsed.method === "connect"
              ? `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}`
              : "invalid handshake: first request must be connect")
            : "invalid request frame";
          setHandshakeState("failed");
          setCloseCause("invalid-handshake", {
            frameId,
            frameMethod,
            frameType,
            handshakeError,
          });
          if (isRequestFrame) {
            const req = parsed;
            send({
              error: errorShape(ErrorCodes.INVALID_REQUEST, handshakeError),
              id: req.id,
              ok: false,
              type: "res",
            });
          } else {
            logWsControl.warn(
              `invalid handshake conn=${connId} peer=${formatForLog(peerLabel)} remote=${remoteAddr ?? "?"} fwd=${formatForLog(forwardedFor ?? "n/a")} origin=${formatForLog(requestOrigin ?? "n/a")} host=${formatForLog(requestHost ?? "n/a")} ua=${formatForLog(requestUserAgent ?? "n/a")}`,
            );
          }
          const closeReason = truncateCloseReason(handshakeError || "invalid handshake");
          if (isRequestFrame) {
            queueMicrotask(() => close(1008, closeReason));
          } else {
            close(1008, closeReason);
          }
          return;
        }

        const frame = parsed;
        const connectParams = frame.params as ConnectParams;
        const clientLabel = connectParams.client.displayName ?? connectParams.client.id;
        const clientMeta = {
          client: connectParams.client.id,
          clientDisplayName: connectParams.client.displayName,
          deviceFamily: connectParams.client.deviceFamily,
          instanceId: connectParams.client.instanceId,
          mode: connectParams.client.mode,
          modelIdentifier: connectParams.client.modelIdentifier,
          platform: connectParams.client.platform,
          version: connectParams.client.version,
        };
        const markHandshakeFailure = (cause: string, meta?: Record<string, unknown>) => {
          setHandshakeState("failed");
          setCloseCause(cause, { ...meta, ...clientMeta });
        };
        const sendHandshakeErrorResponse = (
          code: Parameters<typeof errorShape>[0],
          message: string,
          options?: Parameters<typeof errorShape>[2],
        ) => {
          send({
            error: errorShape(code, message, options),
            id: frame.id,
            ok: false,
            type: "res",
          });
        };

        // Protocol negotiation
        const { minProtocol, maxProtocol } = connectParams;
        if (maxProtocol < PROTOCOL_VERSION || minProtocol > PROTOCOL_VERSION) {
          markHandshakeFailure("protocol-mismatch", {
            expectedProtocol: PROTOCOL_VERSION,
            maxProtocol,
            minProtocol,
          });
          logWsControl.warn(
            `protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`,
          );
          sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "protocol mismatch", {
            details: { expectedProtocol: PROTOCOL_VERSION },
          });
          close(1002, "protocol mismatch");
          return;
        }

        const roleRaw = connectParams.role ?? "operator";
        const role = parseGatewayRole(roleRaw);
        if (!role) {
          markHandshakeFailure("invalid-role", {
            role: roleRaw,
          });
          sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "invalid role");
          close(1008, "invalid role");
          return;
        }
        // Default-deny: scopes must be explicit. Empty/missing scopes means no permissions.
        // Note: If the client does not present a device identity, we can't bind scopes to a paired
        // Device/token, so we will clear scopes after auth to avoid self-declared permissions.
        let scopes = Array.isArray(connectParams.scopes) ? connectParams.scopes : [];
        connectParams.role = role;
        connectParams.scopes = scopes;

        const isControlUi = isOperatorUiClient(connectParams.client);
        const isBrowserOperatorUi = isBrowserOperatorUiClient(connectParams.client);
        const isWebchat = isWebchatConnect(connectParams);
        const resolvedAuth = getResolvedAuth();
        if (enforceOriginCheckForAnyClient || isBrowserOperatorUi || isWebchat) {
          const hostHeaderOriginFallbackEnabled =
            configSnapshot.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
          const originCheck = checkBrowserOrigin({
            allowHostHeaderOriginFallback: hostHeaderOriginFallbackEnabled,
            allowedOrigins: configSnapshot.gateway?.controlUi?.allowedOrigins,
            isLocalClient,
            origin: requestOrigin,
            requestHost,
          });
          if (!originCheck.ok) {
            const errorMessage =
              "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
            markHandshakeFailure("origin-mismatch", {
              host: requestHost ?? "n/a",
              origin: requestOrigin ?? "n/a",
              reason: originCheck.reason,
            });
            sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage, {
              details: {
                code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
                reason: originCheck.reason,
              },
            });
            close(1008, truncateCloseReason(errorMessage));
            return;
          }
          if (originCheck.matchedBy === "host-header-fallback") {
            originCheckMetrics.hostHeaderFallbackAccepted += 1;
            logWsControl.warn(
              `security warning: websocket origin accepted via Host-header fallback conn=${connId} count=${originCheckMetrics.hostHeaderFallbackAccepted} host=${requestHost ?? "n/a"} origin=${requestOrigin ?? "n/a"}`,
            );
            if (hostHeaderOriginFallbackEnabled) {
              logGateway.warn(
                "security metric: gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback accepted a websocket connect request",
              );
            }
          }
        }

        const deviceRaw = connectParams.device;
        let devicePublicKey: string | null = null;
        let deviceAuthPayloadVersion: "v2" | "v3" | null = null;
        const hasTokenAuth = Boolean(connectParams.auth?.token);
        const hasPasswordAuth = Boolean(connectParams.auth?.password);
        const hasSharedAuth = hasTokenAuth || hasPasswordAuth;
        const controlUiAuthPolicy = resolveControlUiAuthPolicy({
          controlUiConfig: configSnapshot.gateway?.controlUi,
          deviceRaw,
          isControlUi,
        });
        const {device} = controlUiAuthPolicy;

        let {
          authResult,
          authOk,
          authMethod,
          sharedAuthOk,
          bootstrapTokenCandidate,
          deviceTokenCandidate,
          deviceTokenCandidateSource,
        } = await resolveConnectAuthState({
          allowRealIpFallback,
          clientIp: browserRateLimitClientIp,
          connectAuth: connectParams.auth,
          hasDeviceIdentity: Boolean(device),
          rateLimiter: authRateLimiter,
          req: upgradeReq,
          resolvedAuth,
          trustedProxies,
        });
        const rejectUnauthorized = (failedAuth: GatewayAuthResult) => {
          const { authProvided, canRetryWithDeviceToken, recommendedNextStep } =
            resolveUnauthorizedHandshakeContext({
              connectAuth: connectParams.auth,
              failedAuth,
              hasDeviceIdentity: Boolean(device),
            });
          markHandshakeFailure("unauthorized", {
            allowTailscale: resolvedAuth.allowTailscale,
            authMode: resolvedAuth.mode,
            authProvided,
            authReason: failedAuth.reason,
            hasDeviceIdentity: Boolean(device),
            localAddr,
            localPort,
            peer: peerLabel,
            remoteAddr,
            remotePort,
            role,
            scopeCount: scopes.length,
          });
          logWsControl.warn(
            `unauthorized conn=${connId} peer=${formatForLog(peerLabel)} remote=${remoteAddr ?? "?"} client=${formatForLog(clientLabel)} ${connectParams.client.mode} v${formatForLog(connectParams.client.version)} role=${role} scopes=${scopes.length} auth=${authProvided} device=${device ? "yes" : "no"} platform=${formatForLog(connectParams.client.platform)} instance=${formatForLog(connectParams.client.instanceId ?? "n/a")} host=${formatForLog(requestHost ?? "n/a")} origin=${formatForLog(requestOrigin ?? "n/a")} ua=${formatForLog(requestUserAgent ?? "n/a")} reason=${failedAuth.reason ?? "unknown"}`,
          );
          const authMessage = formatGatewayAuthFailureMessage({
            authMode: resolvedAuth.mode,
            authProvided,
            client: connectParams.client,
            reason: failedAuth.reason,
          });
          sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, authMessage, {
            details: {
              authReason: failedAuth.reason,
              canRetryWithDeviceToken,
              code: resolveAuthConnectErrorDetailCode(failedAuth.reason),
              recommendedNextStep,
            },
          });
          close(1008, truncateCloseReason(authMessage));
        };
        const clearUnboundScopes = () => {
          if (scopes.length > 0) {
            scopes = [];
            connectParams.scopes = scopes;
          }
        };
        const handleMissingDeviceIdentity = (): boolean => {
          const trustedProxyAuthOk = isTrustedProxyControlUiOperatorAuth({
            authMethod,
            authMode: resolvedAuth.mode,
            authOk,
            isControlUi,
            role,
          });
          const preserveInsecureLocalControlUiScopes =
            isControlUi &&
            controlUiAuthPolicy.allowInsecureAuthConfigured &&
            isLocalClient &&
            (authMethod === "token" || authMethod === "password");
          const decision = evaluateMissingDeviceIdentity({
            authOk,
            controlUiAuthPolicy,
            hasDeviceIdentity: Boolean(device),
            hasSharedAuth,
            isControlUi,
            isLocalClient,
            role,
            sharedAuthOk,
            trustedProxyAuthOk,
          });
          // Shared token/password auth can bypass pairing for trusted operators.
          // Device-less clients only keep self-declared scopes on the explicit
          // Allow path, including trusted token-authenticated backend operators.
          if (
            !device &&
            shouldClearUnboundScopesForMissingDeviceIdentity({
              authMethod,
              controlUiAuthPolicy,
              decision,
              preserveInsecureLocalControlUiScopes,
              trustedProxyAuthOk,
            })
          ) {
            clearUnboundScopes();
          }
          if (decision.kind === "allow") {
            return true;
          }

          if (decision.kind === "reject-control-ui-insecure-auth") {
            const errorMessage =
              "control ui requires device identity (use HTTPS or localhost secure context)";
            markHandshakeFailure("control-ui-insecure-auth", {
              insecureAuthConfigured: controlUiAuthPolicy.allowInsecureAuthConfigured,
            });
            sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage, {
              details: { code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED },
            });
            close(1008, errorMessage);
            return false;
          }

          if (decision.kind === "reject-unauthorized") {
            rejectUnauthorized(authResult);
            return false;
          }

          markHandshakeFailure("device-required");
          sendHandshakeErrorResponse(ErrorCodes.NOT_PAIRED, "device identity required", {
            details: { code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED },
          });
          close(1008, "device identity required");
          return false;
        };
        if (!handleMissingDeviceIdentity()) {
          return;
        }
        if (device) {
          const rejectDeviceAuthInvalid = (reason: string, message: string) => {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              client: connectParams.client.id,
              deviceId: device.id,
              reason,
            });
            send({
              error: errorShape(ErrorCodes.INVALID_REQUEST, message, {
                details: {
                  code: resolveDeviceAuthConnectErrorDetailCode(reason),
                  reason,
                },
              }),
              id: frame.id,
              ok: false,
              type: "res",
            });
            close(1008, message);
          };
          const derivedId = deriveDeviceIdFromPublicKey(device.publicKey);
          if (!derivedId || derivedId !== device.id) {
            rejectDeviceAuthInvalid("device-id-mismatch", "device identity mismatch");
            return;
          }
          const {signedAt} = device;
          if (
            typeof signedAt !== "number" ||
            Math.abs(Date.now() - signedAt) > DEVICE_SIGNATURE_SKEW_MS
          ) {
            rejectDeviceAuthInvalid("device-signature-stale", "device signature expired");
            return;
          }
          const providedNonce = normalizeOptionalString(device.nonce) ?? "";
          if (!providedNonce) {
            rejectDeviceAuthInvalid("device-nonce-missing", "device nonce required");
            return;
          }
          if (providedNonce !== connectNonce) {
            rejectDeviceAuthInvalid("device-nonce-mismatch", "device nonce mismatch");
            return;
          }
          const rejectDeviceSignatureInvalid = () =>
            rejectDeviceAuthInvalid("device-signature", "device signature invalid");
          const payloadVersion = resolveDeviceSignaturePayloadVersion({
            connectParams,
            device,
            nonce: providedNonce,
            role,
            scopes,
            signedAtMs: signedAt,
          });
          if (!payloadVersion) {
            rejectDeviceSignatureInvalid();
            return;
          }
          deviceAuthPayloadVersion = payloadVersion;
          devicePublicKey = normalizeDevicePublicKeyBase64Url(device.publicKey);
          if (!devicePublicKey) {
            rejectDeviceAuthInvalid("device-public-key", "device public key invalid");
            return;
          }
        }

        ({ authResult, authOk, authMethod } = await resolveConnectAuthDecision({
          clientIp: browserRateLimitClientIp,
          deviceId: device?.id,
          hasDeviceIdentity: Boolean(device),
          publicKey: device?.publicKey,
          rateLimiter: authRateLimiter,
          role,
          scopes,
          state: {
            authMethod,
            authOk,
            authResult,
            bootstrapTokenCandidate,
            deviceTokenCandidate,
            deviceTokenCandidateSource,
            sharedAuthOk,
            sharedAuthProvided: hasSharedAuth,
          },
          verifyBootstrapToken: async ({ deviceId, publicKey, token, role, scopes }) =>
            await verifyDeviceBootstrapToken({
              deviceId,
              publicKey,
              role,
              scopes,
              token,
            }),
          verifyDeviceToken,
        }));
        if (!authOk) {
          rejectUnauthorized(authResult);
          return;
        }
        const sharedGatewaySessionGeneration =
          authMethod === "token" || authMethod === "password"
            ? resolveSharedGatewaySessionGeneration(resolvedAuth)
            : undefined;
        if (authMethod === "token" || authMethod === "password") {
          const requiredSharedGatewaySessionGeneration =
            getRequiredSharedGatewaySessionGeneration();
          if (sharedGatewaySessionGeneration !== requiredSharedGatewaySessionGeneration) {
            setCloseCause("gateway-auth-rotated", {
              authGenerationStale: true,
            });
            close(4001, "gateway auth changed");
            return;
          }
        }
        const issuedBootstrapProfile =
          authMethod === "bootstrap-token" && bootstrapTokenCandidate
            ? await getDeviceBootstrapTokenProfile({ token: bootstrapTokenCandidate })
            : null;
        let boundBootstrapProfile: DeviceBootstrapProfile | null = null;
        let handoffBootstrapProfile: DeviceBootstrapProfile | null = null;

        const trustedProxyAuthOk = isTrustedProxyControlUiOperatorAuth({
          authMethod,
          authMode: resolvedAuth.mode,
          authOk,
          isControlUi,
          role,
        });
        const pairingLocality = resolvePairingLocality({
          authMethod,
          connectParams,
          hasBrowserOriginHeader,
          hasProxyHeaders,
          isLocalClient,
          remoteAddress: remoteAddr,
          requestHost,
          requestOrigin,
          sharedAuthOk,
        });
        const skipLocalBackendSelfPairing = shouldSkipLocalBackendSelfPairing({
          authMethod,
          connectParams,
          hasBrowserOriginHeader,
          locality: pairingLocality,
          sharedAuthOk,
        });
        const skipControlUiPairingForDevice = shouldSkipControlUiPairing(
          controlUiAuthPolicy,
          role,
          trustedProxyAuthOk,
          resolvedAuth.mode,
        );
        if (device && devicePublicKey) {
          const formatAuditList = (items: string[] | undefined): string => {
            if (!items || items.length === 0) {
              return "<none>";
            }
            const out = new Set<string>();
            for (const item of items) {
              const trimmed = item.trim();
              if (trimmed) {
                out.add(trimmed);
              }
            }
            if (out.size === 0) {
              return "<none>";
            }
            return [...out].toSorted().join(",");
          };
          const logUpgradeAudit = (
            reason: "role-upgrade" | "scope-upgrade",
            currentRoles: string[] | undefined,
            currentScopes: string[] | undefined,
          ) => {
            logGateway.warn(
              `security audit: device access upgrade requested reason=${reason} device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} roleFrom=${formatAuditList(currentRoles)} roleTo=${role} scopesFrom=${formatAuditList(currentScopes)} scopesTo=${formatAuditList(scopes)} client=${connectParams.client.id} conn=${connId}`,
            );
          };
          const clientPairingMetadata = {
            clientId: connectParams.client.id,
            clientMode: connectParams.client.mode,
            deviceFamily: connectParams.client.deviceFamily,
            displayName: connectParams.client.displayName,
            platform: connectParams.client.platform,
            remoteIp: reportedClientIp,
            role,
            scopes,
          };
          const clientAccessMetadata = {
            clientId: connectParams.client.id,
            clientMode: connectParams.client.mode,
            displayName: connectParams.client.displayName,
            remoteIp: reportedClientIp,
          };
          const requirePairing = async (
            reason: "not-paired" | "role-upgrade" | "scope-upgrade" | "metadata-upgrade",
            existingPairedDevice: Awaited<ReturnType<typeof getPairedDevice>> | null = null,
          ) => {
            const pairingStateAllowsRequestedAccess = (
              pairedCandidate: Awaited<ReturnType<typeof getPairedDevice>>,
            ): boolean => {
              if (!pairedCandidate || pairedCandidate.publicKey !== devicePublicKey) {
                return false;
              }
              if (!hasEffectivePairedDeviceRole(pairedCandidate, role)) {
                return false;
              }
              if (scopes.length === 0) {
                return true;
              }
              const pairedScopes = Array.isArray(pairedCandidate.approvedScopes)
                ? pairedCandidate.approvedScopes
                : (Array.isArray(pairedCandidate.scopes)
                  ? pairedCandidate.scopes
                  : []);
              if (pairedScopes.length === 0) {
                return false;
              }
              return roleScopesAllow({
                allowedScopes: pairedScopes,
                requestedScopes: scopes,
                role,
              });
            };
            if (
              boundBootstrapProfile === null &&
              authMethod === "bootstrap-token" &&
              reason === "not-paired" &&
              role === "node" &&
              scopes.length === 0 &&
              !existingPairedDevice &&
              bootstrapTokenCandidate
            ) {
              boundBootstrapProfile = await getBoundDeviceBootstrapProfile({
                deviceId: device.id,
                publicKey: devicePublicKey,
                token: bootstrapTokenCandidate,
              });
            }
            const allowSilentLocalPairing = shouldAllowSilentLocalPairing({
              hasBrowserOriginHeader,
              isControlUi,
              isWebchat,
              locality: pairingLocality,
              reason,
            });
            // QR bootstrap onboarding stays single-use, but the first node bootstrap handshake
            // Should seed bounded device tokens and only consume the bootstrap token once the
            // Hello-ok path succeeds so reconnects can recover from pre-hello failures.
            const allowSilentBootstrapPairing =
              authMethod === "bootstrap-token" &&
              reason === "not-paired" &&
              role === "node" &&
              scopes.length === 0 &&
              !existingPairedDevice &&
              boundBootstrapProfile !== null;
            const bootstrapProfileForSilentApproval = allowSilentBootstrapPairing
              ? boundBootstrapProfile
              : null;
            const bootstrapPairingRoles = bootstrapProfileForSilentApproval
              ? [...new Set([role, ...bootstrapProfileForSilentApproval.roles])]
              : undefined;
            const pairing = await requestDevicePairing({
              deviceId: device.id,
              publicKey: devicePublicKey,
              ...clientPairingMetadata,
              ...(bootstrapPairingRoles ? { roles: bootstrapPairingRoles } : {}),
              silent:
                reason === "scope-upgrade"
                  ? false
                  : allowSilentLocalPairing || allowSilentBootstrapPairing,
            });
            const context = buildRequestContext();
            let approved: Awaited<ReturnType<typeof approveDevicePairing>> | undefined;
            let resolvedByConcurrentApproval = false;
            let recoveryRequestId: string | undefined = pairing.request.requestId;
            const resolveLivePendingRequestId = async (): Promise<string | undefined> => {
              const pendingList = await listDevicePairing();
              const exactPending = pendingList.pending.find(
                (pending) => pending.requestId === pairing.request.requestId,
              );
              if (exactPending) {
                return exactPending.requestId;
              }
              const replacementPending = pendingList.pending.find(
                (pending) =>
                  pending.deviceId === device.id && pending.publicKey === devicePublicKey,
              );
              return replacementPending?.requestId;
            };
            if (pairing.request.silent === true) {
              approved = bootstrapProfileForSilentApproval
                ? await approveBootstrapDevicePairing(
                    pairing.request.requestId,
                    bootstrapProfileForSilentApproval,
                  )
                : await approveDevicePairing(pairing.request.requestId, {
                    callerScopes: scopes,
                  });
              if (approved?.status === "approved") {
                if (bootstrapProfileForSilentApproval) {
                  handoffBootstrapProfile = bootstrapProfileForSilentApproval;
                }
                logGateway.info(
                  `device pairing auto-approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
                );
                context.broadcast(
                  "device.pair.resolved",
                  {
                    decision: "approved",
                    deviceId: approved.device.deviceId,
                    requestId: pairing.request.requestId,
                    ts: Date.now(),
                  },
                  { dropIfSlow: true },
                );
              } else {
                resolvedByConcurrentApproval = pairingStateAllowsRequestedAccess(
                  await getPairedDevice(device.id),
                );
                let requestStillPending = false;
                if (!resolvedByConcurrentApproval) {
                  recoveryRequestId = await resolveLivePendingRequestId();
                  requestStillPending = recoveryRequestId === pairing.request.requestId;
                }
                if (requestStillPending) {
                  context.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
                }
              }
            } else if (pairing.created) {
              context.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
            }
            // Re-resolve: another connection may have superseded/approved the request since we created it
            recoveryRequestId = await resolveLivePendingRequestId();
            if (
              !(
                pairing.request.silent === true &&
                (approved?.status === "approved" || resolvedByConcurrentApproval)
              )
            ) {
              setHandshakeState("failed");
              setCloseCause("pairing-required", {
                deviceId: device.id,
                ...(recoveryRequestId ? { requestId: recoveryRequestId } : {}),
                reason,
              });
              send({
                error: errorShape(ErrorCodes.NOT_PAIRED, "pairing required", {
                  details: {
                    code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
                    ...(recoveryRequestId ? { requestId: recoveryRequestId } : {}),
                    reason,
                  },
                }),
                id: frame.id,
                ok: false,
                type: "res",
              });
              close(1008, "pairing required");
              return false;
            }
            return true;
          };

          const paired = await getPairedDevice(device.id);
          const isPaired = paired?.publicKey === devicePublicKey;
          if (!isPaired) {
            if (!(skipLocalBackendSelfPairing || skipControlUiPairingForDevice)) {
              // Initial local backend/control-ui self-pairing can bypass the
              // Pairing prompt, but only while the device is still unpaired.
              // Once a device is paired, reconnects must stay inside the
              // Approved role/scope baseline below.
              const ok = await requirePairing("not-paired", paired);
              if (!ok) {
                return;
              }
            }
          } else {
            const claimedPlatform = connectParams.client.platform;
            const pairedPlatform = paired.platform;
            const claimedDeviceFamily = connectParams.client.deviceFamily;
            const pairedDeviceFamily = paired.deviceFamily;
            const metadataPinning = resolvePinnedClientMetadata({
              claimedDeviceFamily,
              claimedPlatform,
              pairedDeviceFamily,
              pairedPlatform,
            });
            const { platformMismatch, deviceFamilyMismatch } = metadataPinning;
            if (platformMismatch || deviceFamilyMismatch) {
              logGateway.warn(
                `security audit: device metadata upgrade requested reason=metadata-upgrade device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} payload=${deviceAuthPayloadVersion ?? "unknown"} claimedPlatform=${claimedPlatform ?? "<none>"} pinnedPlatform=${pairedPlatform ?? "<none>"} claimedDeviceFamily=${claimedDeviceFamily ?? "<none>"} pinnedDeviceFamily=${pairedDeviceFamily ?? "<none>"} client=${connectParams.client.id} conn=${connId}`,
              );
              const ok = await requirePairing("metadata-upgrade", paired);
              if (!ok) {
                return;
              }
            } else {
              if (metadataPinning.pinnedPlatform) {
                connectParams.client.platform = metadataPinning.pinnedPlatform;
              }
              if (metadataPinning.pinnedDeviceFamily) {
                connectParams.client.deviceFamily = metadataPinning.pinnedDeviceFamily;
              }
            }
            const pairedRoles = listEffectivePairedDeviceRoles(paired);
            const pairedScopes = Array.isArray(paired.approvedScopes)
              ? paired.approvedScopes
              : (Array.isArray(paired.scopes)
                ? paired.scopes
                : []);
            const allowedRoles = new Set(pairedRoles);
            if (allowedRoles.size === 0) {
              logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
              const ok = await requirePairing("role-upgrade", paired);
              if (!ok) {
                return;
              }
            } else if (!allowedRoles.has(role)) {
              logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
              const ok = await requirePairing("role-upgrade", paired);
              if (!ok) {
                return;
              }
            }

            if (scopes.length > 0) {
              if (pairedScopes.length === 0) {
                logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
                const ok = await requirePairing("scope-upgrade", paired);
                if (!ok) {
                  return;
                }
              } else {
                const scopesAllowed = roleScopesAllow({
                  allowedScopes: pairedScopes,
                  requestedScopes: scopes,
                  role,
                });
                if (!scopesAllowed) {
                  logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
                  const ok = await requirePairing("scope-upgrade", paired);
                  if (!ok) {
                    return;
                  }
                }
              }
            }

            // Metadata pinning is approval-bound. Reconnects can update access metadata,
            // But platform/device family must stay on the approved pairing record.
            await updatePairedDeviceMetadata(device.id, clientAccessMetadata);
          }
        }

        const deviceToken = device
          ? await ensureDeviceToken({ deviceId: device.id, role, scopes })
          : null;
        const bootstrapDeviceTokens: {
          deviceToken: string;
          role: string;
          scopes: string[];
          issuedAtMs: number;
        }[] = [];
        if (deviceToken) {
          bootstrapDeviceTokens.push({
            deviceToken: deviceToken.token,
            issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs,
            role: deviceToken.role,
            scopes: deviceToken.scopes,
          });
        }
        if (device && handoffBootstrapProfile) {
          const bootstrapProfileForHello = handoffBootstrapProfile as DeviceBootstrapProfile;
          for (const bootstrapRole of bootstrapProfileForHello.roles) {
            if (bootstrapDeviceTokens.some((entry) => entry.role === bootstrapRole)) {
              continue;
            }
            const bootstrapRoleScopes =
              bootstrapRole === "operator"
                ? resolveBootstrapProfileScopesForRole(
                    bootstrapRole,
                    bootstrapProfileForHello.scopes,
                  )
                : [];
            const extraToken = await ensureDeviceToken({
              deviceId: device.id,
              role: bootstrapRole,
              scopes: bootstrapRoleScopes,
            });
            if (!extraToken) {
              continue;
            }
            bootstrapDeviceTokens.push({
              deviceToken: extraToken.token,
              issuedAtMs: extraToken.rotatedAtMs ?? extraToken.createdAtMs,
              role: extraToken.role,
              scopes: extraToken.scopes,
            });
          }
        }

        if (role === "node") {
          const reconciliation = await reconcileNodePairingOnConnect({
            cfg: loadConfig(),
            connectParams,
            pairedNode: await getPairedNode(connectParams.device?.id ?? connectParams.client.id),
            reportedClientIp,
            requestPairing: async (input) => await requestNodePairing(input),
          });
          if (reconciliation.pendingPairing?.created) {
            const requestContext = buildRequestContext();
            requestContext.broadcast("node.pair.requested", reconciliation.pendingPairing.request, {
              dropIfSlow: true,
            });
          }
          connectParams.commands = reconciliation.effectiveCommands;
        }

        const shouldTrackPresence = !isGatewayCliClient(connectParams.client);
        const clientId = connectParams.client.id;
        const {instanceId} = connectParams.client;
        const presenceKey = shouldTrackPresence ? (device?.id ?? instanceId ?? connId) : undefined;

        logWs("in", "connect", {
          auth: authMethod,
          client: connectParams.client.id,
          clientDisplayName: connectParams.client.displayName,
          clientId,
          connId,
          mode: connectParams.client.mode,
          platform: connectParams.client.platform,
          version: connectParams.client.version,
        });

        if (isWebchatConnect(connectParams)) {
          logWsControl.info(
            `webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`,
          );
        }

        if (presenceKey) {
          upsertPresence(presenceKey, {
            deviceFamily: connectParams.client.deviceFamily,
            deviceId: device?.id,
            host: connectParams.client.displayName ?? connectParams.client.id ?? os.hostname(),
            instanceId: device?.id ?? instanceId,
            ip: isLocalClient ? undefined : reportedClientIp,
            mode: connectParams.client.mode,
            modelIdentifier: connectParams.client.modelIdentifier,
            platform: connectParams.client.platform,
            reason: "connect",
            roles: [role],
            scopes,
            version: connectParams.client.version,
          });
          incrementPresenceVersion();
        }

        const snapshot = buildGatewaySnapshot({
          includeSensitive: scopes.includes(ADMIN_SCOPE),
        });
        const cachedHealth = getHealthCache();
        if (cachedHealth) {
          snapshot.health = cachedHealth;
          snapshot.stateVersion.health = getHealthVersion();
        }
        const canvasCapability =
          role === "node" && canvasHostUrl ? mintCanvasCapabilityToken() : undefined;
        const canvasCapabilityExpiresAtMs = canvasCapability
          ? Date.now() + CANVAS_CAPABILITY_TTL_MS
          : undefined;
        const scopedCanvasHostUrl =
          canvasHostUrl && canvasCapability
            ? (buildCanvasScopedHostUrl(canvasHostUrl, canvasCapability) ?? canvasHostUrl)
            : canvasHostUrl;
        const helloOk = {
          auth: deviceToken
            ? {
                deviceToken: deviceToken.token,
                issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs,
                role: deviceToken.role,
                scopes: deviceToken.scopes,
                ...(bootstrapDeviceTokens.length > 1
                  ? { deviceTokens: bootstrapDeviceTokens.slice(1) }
                  : {}),
              }
            : undefined,
          canvasHostUrl: scopedCanvasHostUrl,
          features: { events, methods: gatewayMethods },
          policy: {
            maxBufferedBytes: MAX_BUFFERED_BYTES,
            maxPayload: MAX_PAYLOAD_BYTES,
            tickIntervalMs: TICK_INTERVAL_MS,
          },
          protocol: PROTOCOL_VERSION,
          server: {
            connId,
            version: resolveRuntimeServiceVersion(process.env),
          },
          snapshot,
          type: "hello-ok",
        };

        clearHandshakeTimer();
        const nextClient: GatewayWsClient = {
          canvasCapability,
          canvasCapabilityExpiresAtMs,
          canvasHostUrl,
          clientIp: reportedClientIp,
          connId,
          connect: connectParams,
          presenceKey,
          sharedGatewaySessionGeneration,
          socket,
          usesSharedGatewayAuth: authMethod === "token" || authMethod === "password",
        };
        setSocketMaxPayload(socket, MAX_PAYLOAD_BYTES);
        setClient(nextClient);
        setHandshakeState("connected");
        if (role === "node") {
          const context = buildRequestContext();
          const nodeSession = context.nodeRegistry.register(nextClient, {
            remoteIp: reportedClientIp,
          });
          const instanceIdRaw = connectParams.client.instanceId;
          const instanceId = normalizeOptionalString(instanceIdRaw) ?? "";
          const nodeIdsForPairing = new Set<string>([nodeSession.nodeId]);
          if (instanceId) {
            nodeIdsForPairing.add(instanceId);
          }
          for (const nodeId of nodeIdsForPairing) {
            void updatePairedNodeMetadata(nodeId, {
              lastConnectedAtMs: nodeSession.connectedAtMs,
            }).catch((error) =>
              logGateway.warn(`failed to record last connect for ${nodeId}: ${formatForLog(error)}`),
            );
          }
          recordRemoteNodeInfo({
            commands: nodeSession.commands,
            deviceFamily: nodeSession.deviceFamily,
            displayName: nodeSession.displayName,
            nodeId: nodeSession.nodeId,
            platform: nodeSession.platform,
            remoteIp: nodeSession.remoteIp,
          });
          void refreshRemoteNodeBins({
            cfg: loadConfig(),
            commands: nodeSession.commands,
            deviceFamily: nodeSession.deviceFamily,
            nodeId: nodeSession.nodeId,
            platform: nodeSession.platform,
          }).catch((error) =>
            logGateway.warn(
              `remote bin probe failed for ${nodeSession.nodeId}: ${formatForLog(error)}`,
            ),
          );
          void loadVoiceWakeConfig()
            .then((cfg) => {
              context.nodeRegistry.sendEvent(nodeSession.nodeId, "voicewake.changed", {
                triggers: cfg.triggers,
              });
            })
            .catch((error) =>
              logGateway.warn(
                `voicewake snapshot failed for ${nodeSession.nodeId}: ${formatForLog(error)}`,
              ),
            );
        }

        try {
          await sendFrame({ id: frame.id, ok: true, payload: helloOk, type: "res" });
        } catch (error) {
          setCloseCause("hello-send-failed", { error: formatForLog(error) });
          close();
          return;
        }
        if (authMethod === "bootstrap-token" && bootstrapTokenCandidate && device) {
          try {
            if (handoffBootstrapProfile) {
              const revoked = await revokeDeviceBootstrapToken({
                token: bootstrapTokenCandidate,
              });
              if (!revoked.removed) {
                logGateway.warn(
                  `bootstrap token revoke skipped after device-token handoff device=${device.id}`,
                );
              }
            } else if (issuedBootstrapProfile) {
              const redemption = await redeemDeviceBootstrapTokenProfile({
                role,
                scopes,
                token: bootstrapTokenCandidate,
              });
              if (redemption.fullyRedeemed) {
                const revoked = await revokeDeviceBootstrapToken({
                  token: bootstrapTokenCandidate,
                });
                if (!revoked.removed) {
                  logGateway.warn(
                    `bootstrap token revoke skipped after profile redemption device=${device.id}`,
                  );
                }
              }
            }
          } catch (error) {
            logGateway.warn(
              `bootstrap token post-connect bookkeeping failed device=${device.id}: ${formatForLog(error)}`,
            );
          }
        }
        logWs("out", "hello-ok", {
          connId,
          events: events.length,
          methods: gatewayMethods.length,
          presence: snapshot.presence.length,
          stateVersion: snapshot.stateVersion.presence,
        });
        void refreshGatewayHealthSnapshot({ probe: true }).catch((error) =>
          logHealth.error(`post-connect health refresh failed: ${formatError(error)}`),
        );
        return;
      }

      if (client.usesSharedGatewayAuth) {
        const requiredSharedGatewaySessionGeneration = getRequiredSharedGatewaySessionGeneration();
        if (client.sharedGatewaySessionGeneration !== requiredSharedGatewaySessionGeneration) {
          setCloseCause("gateway-auth-rotated", {
            authGenerationStale: true,
          });
          close(4001, "gateway auth changed");
          return;
        }
      }

      // After handshake, accept only req frames
      if (!validateRequestFrame(parsed)) {
        send({
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`,
          ),
          id: (parsed as { id?: unknown })?.id ?? "invalid",
          ok: false,
          type: "res",
        });
        return;
      }
      const req = parsed;
      logWs("in", "req", { connId, id: req.id, method: req.method });
      const respond = (
        ok: boolean,
        payload?: unknown,
        error?: ErrorShape,
        meta?: Record<string, unknown>,
      ) => {
        send({ error, id: req.id, ok, payload, type: "res" });
        const unauthorizedRoleError = isUnauthorizedRoleError(error);
        let logMeta = meta;
        if (unauthorizedRoleError) {
          const unauthorizedDecision = unauthorizedFloodGuard.registerUnauthorized();
          if (unauthorizedDecision.suppressedSinceLastLog > 0) {
            logMeta = {
              ...logMeta,
              suppressedUnauthorizedResponses: unauthorizedDecision.suppressedSinceLastLog,
            };
          }
          if (!unauthorizedDecision.shouldLog) {
            return;
          }
          if (unauthorizedDecision.shouldClose) {
            setCloseCause("repeated-unauthorized-requests", {
              method: req.method,
              unauthorizedCount: unauthorizedDecision.count,
            });
            queueMicrotask(() => close(1008, "repeated unauthorized calls"));
          }
          logMeta = {
            ...logMeta,
            unauthorizedCount: unauthorizedDecision.count,
          };
        } else {
          unauthorizedFloodGuard.reset();
        }
        logWs("out", "res", {
          connId,
          errorCode: error?.code,
          errorMessage: error?.message,
          id: req.id,
          method: req.method,
          ok,
          ...logMeta,
        });
      };

      void (async () => {
        await handleGatewayRequest({
          client,
          context: buildRequestContext(),
          extraHandlers,
          isWebchatConnect,
          req,
          respond,
        });
      })().catch((error) => {
        logGateway.error(`request handler failed: ${formatForLog(error)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
      });
    } catch (error) {
      logGateway.error(`parse/handle error: ${String(error)}`);
      logWs("out", "parse-error", { connId, error: formatForLog(error) });
      if (!getClient()) {
        close();
      }
    }
  });
}

function getRawDataByteLength(data: unknown): number {
  if (Buffer.isBuffer(data)) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return Buffer.byteLength(String(data));
}

function setSocketMaxPayload(socket: WebSocket, maxPayload: number): void {
  const receiver = (socket as { _receiver?: { _maxPayload?: number } })._receiver;
  if (receiver) {
    receiver._maxPayload = maxPayload;
  }
}
