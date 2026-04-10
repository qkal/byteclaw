import type { Command } from "commander";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { withProgress } from "../progress.js";

export interface GatewayRpcOpts {
  config?: OpenClawConfig;
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  expectFinal?: boolean;
  json?: boolean;
}

export const gatewayCallOpts = (cmd: Command) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--expect-final", "Wait for final response (agent)", false)
    .option("--json", "Output JSON", false);

export const callGatewayCli = async (method: string, opts: GatewayRpcOpts, params?: unknown) =>
  withProgress(
    {
      enabled: opts.json !== true,
      indeterminate: true,
      label: `Gateway ${method}`,
    },
    async () =>
      await callGateway({
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        config: opts.config,
        expectFinal: Boolean(opts.expectFinal),
        method,
        mode: GATEWAY_CLIENT_MODES.CLI,
        params,
        password: opts.password,
        timeoutMs: Number(opts.timeout ?? 10_000),
        token: opts.token,
        url: opts.url,
      }),
  );
