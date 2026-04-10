import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import {
  type DeviceIdentity,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { rawDataToString } from "../infra/ws.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { startGatewayServer } from "./server.js";

export async function getFreeGatewayPort(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });
}

export async function connectGatewayClient(params: {
  url: string;
  token?: string;
  deviceToken?: string;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  mode?: GatewayClientMode;
  platform?: string;
  deviceFamily?: string;
  role?: "operator" | "node";
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  instanceId?: string;
  deviceIdentity?: DeviceIdentity;
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
  connectChallengeTimeoutMs?: number;
  timeoutMs?: number;
  timeoutMessage?: string;
}) {
  const role = params.role ?? "operator";
  const scopes = params.scopes ?? (role === "node" ? [] : undefined);
  const platform = params.platform ?? process.platform;
  const identityRoot = process.env.OPENCLAW_STATE_DIR ?? process.env.HOME ?? os.tmpdir();
  const deviceIdentity =
    params.deviceIdentity ??
    loadOrCreateDeviceIdentity(
      (() => {
        const safe = normalizeLowercaseStringOrEmpty(
          `${params.clientName ?? GATEWAY_CLIENT_NAMES.TEST}-${params.mode ?? GATEWAY_CLIENT_MODES.TEST}-${platform}-${params.deviceFamily ?? "none"}-${role}`.replace(
            /[^a-zA-Z0-9._-]+/g,
            "_",
          ),
        );
        return path.join(identityRoot, "test-device-identities", `${safe}.json`);
      })(),
    );
  return await new Promise<InstanceType<typeof GatewayClient>>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, client?: InstanceType<typeof GatewayClient>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(client as InstanceType<typeof GatewayClient>);
      }
    };
    const client = new GatewayClient({
      caps: params.caps,
      clientDisplayName: params.clientDisplayName ?? "vitest",
      clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.TEST,
      clientVersion: params.clientVersion ?? "dev",
      commands: params.commands,
      connectChallengeTimeoutMs: params.connectChallengeTimeoutMs ?? 0,
      deviceFamily: params.deviceFamily,
      deviceIdentity,
      deviceToken: params.deviceToken,
      instanceId: params.instanceId,
      mode: params.mode ?? GATEWAY_CLIENT_MODES.TEST,
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
      onConnectError: (err) => stop(err),
      onEvent: params.onEvent,
      onHelloOk: () => stop(undefined, client),
      platform,
      role,
      scopes,
      token: params.token,
      url: params.url,
    });
    const timer = setTimeout(
      () => stop(new Error(params.timeoutMessage ?? "gateway connect timeout")),
      params.timeoutMs ?? 10_000,
    );
    timer.unref();
    client.start();
  });
}

export async function disconnectGatewayClient(client: GatewayClient): Promise<void> {
  await client.stopAndWait();
}

export async function connectDeviceAuthReq(params: { url: string; token?: string }) {
  const ws = new WebSocket(params.url);
  const connectNoncePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timeout waiting for connect challenge")),
      5000,
    );
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${rawDataToString(reason)}`));
    };
    const handler = (data: WebSocket.RawData) => {
      try {
        const obj = JSON.parse(rawDataToString(data)) as {
          type?: unknown;
          event?: unknown;
          payload?: { nonce?: unknown } | null;
        };
        if (obj.type !== "event" || obj.event !== "connect.challenge") {
          return;
        }
        const nonce = obj.payload?.nonce;
        if (typeof nonce !== "string" || nonce.trim().length === 0) {
          return;
        }
        clearTimeout(timer);
        ws.off("message", handler);
        ws.off("close", closeHandler);
        resolve(nonce.trim());
      } catch {
        // Ignore parse errors while waiting for challenge
      }
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
  await new Promise<void>((resolve) => ws.once("open", resolve));
  const connectNonce = await connectNoncePromise;
  const identity = loadOrCreateDeviceIdentity();
  const signedAtMs = Date.now();
  const {platform} = process;
  const payload = buildDeviceAuthPayloadV3({
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
    deviceId: identity.deviceId,
    nonce: connectNonce,
    platform,
    role: "operator",
    scopes: [],
    signedAtMs,
    token: params.token ?? null,
  });
  const device = {
    id: identity.deviceId,
    nonce: connectNonce,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
  };
  ws.send(
    JSON.stringify({
      id: "c1",
      method: "connect",
      params: {
        auth: params.token ? { token: params.token } : undefined,
        caps: [],
        client: {
          displayName: "vitest",
          id: GATEWAY_CLIENT_NAMES.TEST,
          mode: GATEWAY_CLIENT_MODES.TEST,
          platform,
          version: "dev",
        },
        device,
        maxProtocol: PROTOCOL_VERSION,
        minProtocol: PROTOCOL_VERSION,
      },
      type: "req",
    }),
  );
  const res = await new Promise<{
    type: "res";
    id: string;
    ok: boolean;
    error?: { message?: string };
  }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${rawDataToString(reason)}`));
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(rawDataToString(data)) as { type?: unknown; id?: unknown };
      if (obj?.type !== "res" || obj?.id !== "c1") {
        return;
      }
      clearTimeout(timer);
      ws.off("message", handler);
      ws.off("close", closeHandler);
      resolve(
        obj as {
          type: "res";
          id: string;
          ok: boolean;
          error?: { message?: string };
        },
      );
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
  ws.close();
  return res;
}

export async function startGatewayWithClient(params: {
  cfg: unknown;
  configPath: string;
  token: string;
  clientDisplayName?: string;
}) {
  await writeFile(params.configPath, `${JSON.stringify(params.cfg, null, 2)}\n`);
  process.env.OPENCLAW_CONFIG_PATH = params.configPath;
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();

  const port = await getFreeGatewayPort();
  const server = await startGatewayServer(port, {
    auth: { mode: "token", token: params.token },
    bind: "loopback",
    controlUiEnabled: false,
  });
  const client = await connectGatewayClient({
    clientDisplayName: params.clientDisplayName,
    token: params.token,
    url: `ws://127.0.0.1:${port}`,
  });

  return { client, port, server };
}
