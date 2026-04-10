import { URL } from "node:url";
import type { GatewayConfig } from "../config/types.gateway.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  type DeviceIdentity,
  loadOrCreateDeviceIdentity,
  signDevicePayload,
} from "./device-identity.js";
import { formatErrorMessage } from "./errors.js";
import { normalizeHostname } from "./net/hostname.js";

export type ApnsRelayPushType = "alert" | "background";

export interface ApnsRelayConfig {
  baseUrl: string;
  timeoutMs: number;
}

export type ApnsRelayConfigResolution =
  | { ok: true; value: ApnsRelayConfig }
  | { ok: false; error: string };

export interface ApnsRelayPushResponse {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  environment: "production";
  tokenSuffix?: string;
}

export type ApnsRelayRequestSender = (params: {
  relayConfig: ApnsRelayConfig;
  sendGrant: string;
  relayHandle: string;
  gatewayDeviceId: string;
  signature: string;
  signedAtMs: number;
  bodyJson: string;
  pushType: ApnsRelayPushType;
  priority: "10" | "5";
  payload: object;
}) => Promise<ApnsRelayPushResponse>;

const DEFAULT_APNS_RELAY_TIMEOUT_MS = 10_000;
const GATEWAY_DEVICE_ID_HEADER = "x-openclaw-gateway-device-id";
const GATEWAY_SIGNATURE_HEADER = "x-openclaw-gateway-signature";
const GATEWAY_SIGNED_AT_HEADER = "x-openclaw-gateway-signed-at-ms";

function normalizeNonEmptyString(value: string | undefined): string | null {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTimeoutMs(value: string | number | undefined): number {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? normalizeOptionalString(value)
        : undefined;
  if (raw === undefined || raw === "") {
    return DEFAULT_APNS_RELAY_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_APNS_RELAY_TIMEOUT_MS;
  }
  return Math.max(1000, Math.trunc(parsed));
}

function readAllowHttp(value: string | undefined): boolean {
  const normalized = normalizeOptionalString(value)
    ? normalizeLowercaseStringOrEmpty(value)
    : undefined;
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isLoopbackRelayHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function parseReason(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function buildRelayGatewaySignaturePayload(params: {
  gatewayDeviceId: string;
  signedAtMs: number;
  bodyJson: string;
}): string {
  return [
    "openclaw-relay-send-v1",
    params.gatewayDeviceId.trim(),
    String(Math.trunc(params.signedAtMs)),
    params.bodyJson,
  ].join("\n");
}

export function resolveApnsRelayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  gatewayConfig?: GatewayConfig,
): ApnsRelayConfigResolution {
  const configuredRelay = gatewayConfig?.push?.apns?.relay;
  const envBaseUrl = normalizeNonEmptyString(env.OPENCLAW_APNS_RELAY_BASE_URL);
  const configBaseUrl = normalizeNonEmptyString(configuredRelay?.baseUrl);
  const baseUrl = envBaseUrl ?? configBaseUrl;
  const baseUrlSource = envBaseUrl
    ? "OPENCLAW_APNS_RELAY_BASE_URL"
    : "gateway.push.apns.relay.baseUrl";
  if (!baseUrl) {
    return {
      error:
        "APNs relay config missing: set gateway.push.apns.relay.baseUrl or OPENCLAW_APNS_RELAY_BASE_URL",
      ok: false,
    };
  }

  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    if (!parsed.hostname) {
      throw new Error("host required");
    }
    if (parsed.protocol === "http:" && !readAllowHttp(env.OPENCLAW_APNS_RELAY_ALLOW_HTTP)) {
      throw new Error(
        "http relay URLs require OPENCLAW_APNS_RELAY_ALLOW_HTTP=true (development only)",
      );
    }
    if (parsed.protocol === "http:" && !isLoopbackRelayHostname(parsed.hostname)) {
      throw new Error("http relay URLs are limited to loopback hosts");
    }
    if (parsed.username || parsed.password) {
      throw new Error("userinfo is not allowed");
    }
    if (parsed.search || parsed.hash) {
      throw new Error("query and fragment are not allowed");
    }
    return {
      ok: true,
      value: {
        baseUrl: parsed.toString().replace(/\/+$/, ""),
        timeoutMs: normalizeTimeoutMs(
          env.OPENCLAW_APNS_RELAY_TIMEOUT_MS ?? configuredRelay?.timeoutMs,
        ),
      },
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    return {
      error: `invalid ${baseUrlSource} (${baseUrl}): ${message}`,
      ok: false,
    };
  }
}

async function sendApnsRelayRequest(params: {
  relayConfig: ApnsRelayConfig;
  sendGrant: string;
  relayHandle: string;
  gatewayDeviceId: string;
  signature: string;
  signedAtMs: number;
  bodyJson: string;
  pushType: ApnsRelayPushType;
  priority: "10" | "5";
  payload: object;
}): Promise<ApnsRelayPushResponse> {
  const response = await fetch(`${params.relayConfig.baseUrl}/v1/push/send`, {
    body: params.bodyJson,
    headers: {
      authorization: `Bearer ${params.sendGrant}`,
      "content-type": "application/json",
      [GATEWAY_DEVICE_ID_HEADER]: params.gatewayDeviceId,
      [GATEWAY_SIGNATURE_HEADER]: params.signature,
      [GATEWAY_SIGNED_AT_HEADER]: String(params.signedAtMs),
    },
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(params.relayConfig.timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    return {
      environment: "production",
      ok: false,
      reason: "RelayRedirectNotAllowed",
      status: response.status,
    };
  }

  let json: unknown = null;
  try {
    json = (await response.json()) as unknown;
  } catch {
    json = null;
  }
  const body =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};

  const status =
    typeof body.status === "number" && Number.isFinite(body.status)
      ? Math.trunc(body.status)
      : response.status;
  return {
    apnsId: parseReason(body.apnsId),
    environment: "production",
    ok: typeof body.ok === "boolean" ? body.ok : response.ok && status >= 200 && status < 300,
    reason: parseReason(body.reason),
    status,
    tokenSuffix: parseReason(body.tokenSuffix),
  };
}

export async function sendApnsRelayPush(params: {
  relayConfig: ApnsRelayConfig;
  sendGrant: string;
  relayHandle: string;
  pushType: ApnsRelayPushType;
  priority: "10" | "5";
  payload: object;
  gatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
  requestSender?: ApnsRelayRequestSender;
}): Promise<ApnsRelayPushResponse> {
  const sender = params.requestSender ?? sendApnsRelayRequest;
  const gatewayIdentity = params.gatewayIdentity ?? loadOrCreateDeviceIdentity();
  const signedAtMs = Date.now();
  const bodyJson = JSON.stringify({
    payload: params.payload,
    priority: Number(params.priority),
    pushType: params.pushType,
    relayHandle: params.relayHandle,
  });
  const signature = signDevicePayload(
    gatewayIdentity.privateKeyPem,
    buildRelayGatewaySignaturePayload({
      bodyJson,
      gatewayDeviceId: gatewayIdentity.deviceId,
      signedAtMs,
    }),
  );
  return await sender({
    bodyJson,
    gatewayDeviceId: gatewayIdentity.deviceId,
    payload: params.payload,
    priority: params.priority,
    pushType: params.pushType,
    relayConfig: params.relayConfig,
    relayHandle: params.relayHandle,
    sendGrant: params.sendGrant,
    signature,
    signedAtMs,
  });
}
