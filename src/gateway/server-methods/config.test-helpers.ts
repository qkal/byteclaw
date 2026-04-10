import { type Mock, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
interface GatewayLogMocks {
  error: UnknownMock;
  warn: UnknownMock;
  info: UnknownMock;
  debug: UnknownMock;
}
interface ConfigHandlerHarness {
  options: GatewayRequestHandlerOptions;
  respond: UnknownMock;
  logGateway: GatewayLogMocks;
  disconnectClientsUsingSharedGatewayAuth: UnknownMock;
}

function createGatewayLog(): GatewayLogMocks {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

export function createConfigWriteSnapshot(config: OpenClawConfig) {
  return {
    snapshot: {
      config,
      exists: true,
      hash: "base-hash",
      issues: [],
      legacyIssues: [],
      parsed: config,
      path: "/tmp/openclaw.json",
      raw: JSON.stringify(config, null, 2),
      resolved: config,
      runtimeConfig: config,
      sourceConfig: config,
      valid: true,
      warnings: [],
    },
    writeOptions: {} as Record<string, never>,
  };
}

export function createConfigHandlerHarness(args?: {
  method?: string;
  params?: unknown;
  overrides?: Partial<GatewayRequestHandlerOptions>;
  contextOverrides?: Partial<GatewayRequestHandlerOptions["context"]>;
}): ConfigHandlerHarness {
  const logGateway = createGatewayLog();
  const disconnectClientsUsingSharedGatewayAuth = vi.fn();
  const respond = vi.fn();
  const options = {
    client: null,
    context: {
      disconnectClientsUsingSharedGatewayAuth,
      logGateway,
      ...args?.contextOverrides,
    },
    isWebchatConnect: () => false,
    params: args?.params ?? {},
    req: { id: "1", method: args?.method ?? "config.get", type: "req" },
    respond,
    ...args?.overrides,
  } as unknown as GatewayRequestHandlerOptions;
  return {
    disconnectClientsUsingSharedGatewayAuth,
    logGateway,
    options,
    respond,
  };
}

export async function flushConfigHandlerMicrotasks() {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}
