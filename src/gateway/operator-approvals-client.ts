import type { OpenClawConfig } from "../config/config.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";

export async function createOperatorApprovalsGatewayClient(
  params: Pick<
    GatewayClientOptions,
    "clientDisplayName" | "onClose" | "onConnectError" | "onEvent" | "onHelloOk"
  > & {
    config: OpenClawConfig;
    gatewayUrl?: string;
  },
): Promise<GatewayClient> {
  const bootstrap = await resolveGatewayClientBootstrap({
    config: params.config,
    env: process.env,
    gatewayUrl: params.gatewayUrl,
  });

  return new GatewayClient({
    clientDisplayName: params.clientDisplayName,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    onClose: params.onClose,
    onConnectError: params.onConnectError,
    onEvent: params.onEvent,
    onHelloOk: params.onHelloOk,
    password: bootstrap.auth.password,
    scopes: ["operator.approvals"],
    token: bootstrap.auth.token,
    url: bootstrap.url,
  });
}

export async function withOperatorApprovalsGatewayClient<T>(
  params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
  },
  run: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const markReady = () => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    resolveReady();
  };
  const failReady = (err: unknown) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    rejectReady(err);
  };

  const gatewayClient = await createOperatorApprovalsGatewayClient({
    clientDisplayName: params.clientDisplayName,
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    onClose: (code, reason) => {
      failReady(new Error(`gateway closed (${code}): ${reason}`));
    },
    onConnectError: (err) => {
      failReady(err);
    },
    onHelloOk: () => {
      markReady();
    },
  });

  try {
    gatewayClient.start();
    await ready;
    return await run(gatewayClient);
  } finally {
    await gatewayClient.stopAndWait().catch(() => {
      gatewayClient.stop();
    });
  }
}
